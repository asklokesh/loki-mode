#!/usr/bin/env bash
#
# release.sh - Automated release script for Loki Mode
#
# Usage:
#   ./scripts/release.sh patch|minor|major [--dry-run]
#   ./scripts/release.sh patch|minor|major --bump-only
#
# This script:
#   1. Bumps version in every file CLAUDE.md's "Release Workflow" section 1
#      lists (see FILES_TO_BUMP below), except the ones documented as
#      intentionally left to the Captain.
#   2. Updates CHANGELOG.md from conventional commits
#   3. Commits and pushes (triggers GitHub Actions release workflow)
#
# --bump-only (S-108, ends the D27 VERSION editor-tool exception): bumps
# every version file plus loki-ts/dist, then exits. No prompt, no git add,
# no commit, no push -- the Release Manager runs this instead of hand-editing
# VERSION, then commits the result itself.
#
# RELEASE GATE (S-108, founder P0): a release is a lookup of an already-
# verified commit, never a bump on an unverified tree. Before ANY bump (this
# includes --bump-only) the script requires a completed/success run of both
# the "Tests" and "Bun Parity" GitHub Actions workflows at HEAD's exact SHA.
# No matching run -> refuse, exit 3 (RELEASE_ON_RED). --dry-run skips the
# gate since it writes nothing. LOKI_RELEASE_ALLOW_RED=1 bypasses the gate
# for tests only -- never set it for a real release.
#
# Files intentionally NOT bumped by this script (left to the Captain):
#   - vscode-extension/package.json: CLAUDE.md marks this DEPRECATED since
#     v7.2.0 ("Bump only if vendoring; otherwise skip"). The extension is no
#     longer published, so this script never touches it.
#   - CHANGELOG.md: handled separately by update-changelog.sh (step 2 below),
#     which writes a new dated entry rather than a simple string replace.
#   - README.md / docs/INSTALLATION.md Docker tags / docker-compose.yml:
#     CLAUDE.md calls these out for MAJOR/MINOR bumps only, and today they
#     reference `:latest` or carry no pinned version string to replace.
#     Nothing for a version-bump regex to match.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_step() { echo -e "${CYAN}[STEP]${NC} $*"; }

DRY_RUN="false"
BUMP_ONLY="false"
BUMP_TYPE=""

# Parse arguments. Sets the globals DRY_RUN and BUMP_TYPE directly instead of
# echoing a return value, because a caller that wraps this in $(...) runs it
# in a subshell and any global it sets (DRY_RUN, an early `exit 0` for --help)
# is lost when the subshell exits.
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            patch|minor|major)
                BUMP_TYPE="$1"
                ;;
            --dry-run)
                DRY_RUN="true"
                ;;
            --bump-only)
                BUMP_ONLY="true"
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                log_error "Unknown argument: $1"
                usage
                exit 1
                ;;
        esac
        shift
    done

    if [[ -z "$BUMP_TYPE" ]]; then
        log_error "Bump type required: patch, minor, or major"
        usage
        exit 1
    fi
}

usage() {
    cat << EOF
Usage: $(basename "$0") <patch|minor|major> [--dry-run]

Arguments:
  patch    Bump patch version (x.y.Z)
  minor    Bump minor version (x.Y.0)
  major    Bump major version (X.0.0)

Options:
  --dry-run    Show what would be done without making changes
  --bump-only  Bump version files + loki-ts/dist, then exit. No commit, no push.
  -h, --help   Show this help message

Examples:
  $(basename "$0") patch          # 5.8.2 -> 5.8.3
  $(basename "$0") minor          # 5.8.2 -> 5.9.0
  $(basename "$0") major          # 5.8.2 -> 6.0.0
  $(basename "$0") patch --dry-run
  $(basename "$0") patch --bump-only
EOF
}

# Get current version from VERSION file
get_current_version() {
    if [[ -f "$ROOT_DIR/VERSION" ]]; then
        cat "$ROOT_DIR/VERSION" | tr -d '\n'
    else
        echo "0.0.0"
    fi
}

# Bump version based on type
bump_version() {
    local current="$1"
    local type="$2"

    IFS='.' read -r major minor patch <<< "$current"

    case "$type" in
        major)
            echo "$((major + 1)).0.0"
            ;;
        minor)
            echo "$major.$((minor + 1)).0"
            ;;
        patch)
            echo "$major.$minor.$((patch + 1))"
            ;;
    esac
}

# Apply a sed -E expression to a file in place, portably (no BSD/GNU -i
# difference), via a temp file + mv so a mid-write failure can't truncate
# the original.
#
# mktemp always creates its file at mode 600 regardless of umask, and mv
# (same-directory rename) keeps the temp file's own mode rather than the
# original's -- so without the `cp -p` below, every bumped file (VERSION,
# package.json, Dockerfile, etc.) would silently end up at 600 instead of
# its original 644 after every release. `cp -p` copies the original's mode
# (and timestamps) onto the temp file before sed's `>` redirect overwrites
# its content; a `>` redirect opens and truncates the existing inode, it
# does not recreate the file, so the mode `cp -p` set survives the redirect.
apply_sed() {
    local file="$1"
    local expr="$2"
    local tmp
    tmp="$(mktemp "${file}.XXXXXX")"
    cp -p "$file" "$tmp"
    if sed -E "$expr" "$file" > "$tmp"; then
        mv "$tmp" "$file"
    else
        rm -f "$tmp"
        return 1
    fi
}

# Update the version string at a specific "slot" in a file, identified by a
# sed -E expression. Never does a global literal find/replace: that would
# also rewrite unrelated version mentions in prose (CHANGELOG headings,
# SKILL.md body text like "v8.0.0", etc.) and would silently no-op on a file
# that has already drifted from $old_version (observed on wiki/*.md and
# docs/INSTALLATION.md, which sit at older versions than VERSION today).
#
# After writing, asserts the new version now appears in that exact slot, so
# a pattern that stops matching (a reformatted file, a typo in this script)
# fails the release instead of silently shipping a stale file.
#
# $5 (optional, default "false"): pass "true" for a slot the checklist itself
# marks as conditional ("if present"). A conditional slot that fails to match
# is a documented case, not drift -- warn and move on instead of aborting the
# release, the same way a missing file already does above.
update_version_slot() {
    local file="$1"
    local expr="$2"
    local assert_pattern="$3"
    local description="$4"
    local optional="${5:-false}"

    if [[ ! -f "$file" ]]; then
        log_warn "File not found: $file"
        return
    fi

    if [ "$DRY_RUN" = "true" ]; then
        local diff_output
        diff_output="$(sed -E "$expr" "$file" | diff -u "$file" - || true)"
        if [[ -n "$diff_output" ]]; then
            log_info "[DRY-RUN] Would update $description ($file):"
            echo "$diff_output"
        else
            log_warn "[DRY-RUN] $description ($file): pattern did not match, no change would be made"
        fi
        return
    fi

    apply_sed "$file" "$expr"

    if ! grep -qE "$assert_pattern" "$file"; then
        if [ "$optional" = "true" ]; then
            log_warn "$description not present in $file, skipping (checklist marks this slot optional)"
            return
        fi
        log_error "Failed to update $description in $file (slot pattern no longer matches after edit)"
        exit 1
    fi

    log_success "Updated $description in $file"
}

# Bump every file CLAUDE.md's "Release Workflow > 1. Version Bump - ALL
# Files" section requires, each at its own format-specific slot. Kept as a
# flat sequence of calls (not an associative array) for bash 3.2
# compatibility (macOS ships 3.2; `declare -A` is bash 4+).
#
# Deliberately excludes:
#   - vscode-extension/package.json (DEPRECATED, see header comment)
#   - CHANGELOG.md (handled by update-changelog.sh in step 2)
bump_all_version_files() {
    local new="$1"
    local digits='[0-9]+\.[0-9]+\.[0-9]+'

    update_version_slot "$ROOT_DIR/VERSION" \
        "s/^${digits}\$/${new}/" \
        "^${new}\$" \
        "VERSION"

    update_version_slot "$ROOT_DIR/package.json" \
        "s/^(  \"version\": \")${digits}(\",?)\$/\\1${new}\\2/" \
        "^  \"version\": \"${new}\"" \
        "package.json version"

    update_version_slot "$ROOT_DIR/SKILL.md" \
        "s/^(# Loki Mode v)${digits}\$/\\1${new}/" \
        "^# Loki Mode v${new}\$" \
        "SKILL.md header"

    update_version_slot "$ROOT_DIR/SKILL.md" \
        "s/^(\*\*v)${digits}( \|)/\\1${new}\\2/" \
        "^\*\*v${new} \|" \
        "SKILL.md footer"

    update_version_slot "$ROOT_DIR/Dockerfile" \
        "s/^(LABEL version=\")${digits}(\")\$/\\1${new}\\2/" \
        "^LABEL version=\"${new}\"\$" \
        "Dockerfile LABEL version"

    update_version_slot "$ROOT_DIR/Dockerfile" \
        "s/^(LABEL org\.opencontainers\.image\.version=\")${digits}(\")\$/\\1${new}\\2/" \
        "^LABEL org\.opencontainers\.image\.version=\"${new}\"\$" \
        "Dockerfile LABEL org.opencontainers.image.version"

    update_version_slot "$ROOT_DIR/Dockerfile.sandbox" \
        "s/^(LABEL version=\")${digits}(\")\$/\\1${new}\\2/" \
        "^LABEL version=\"${new}\"\$" \
        "Dockerfile.sandbox LABEL version"

    update_version_slot "$ROOT_DIR/Dockerfile.sandbox" \
        "s/^(LABEL org\.opencontainers\.image\.version=\")${digits}(\")\$/\\1${new}\\2/" \
        "^LABEL org\.opencontainers\.image\.version=\"${new}\"\$" \
        "Dockerfile.sandbox LABEL org.opencontainers.image.version"

    update_version_slot "$ROOT_DIR/plugins/loki-mode/.claude-plugin/plugin.json" \
        "s/^(  \"version\": \")${digits}(\",?)\$/\\1${new}\\2/" \
        "^  \"version\": \"${new}\"" \
        "plugin.json version"

    # server.json has two version slots: top-level (2-space indent) and
    # packages[loki-mode].version (6-space indent in the current layout).
    update_version_slot "$ROOT_DIR/server.json" \
        "s/^(  \"version\": \")${digits}(\",?)\$/\\1${new}\\2/" \
        "^  \"version\": \"${new}\"" \
        "server.json top-level version"

    update_version_slot "$ROOT_DIR/server.json" \
        "s/^(      \"version\": \")${digits}(\",?)\$/\\1${new}\\2/" \
        "^      \"version\": \"${new}\"" \
        "server.json packages[].version"

    # Optional: the release checklist lists this as "if present". CLAUDE.md
    # (S-78) now points at VERSION instead of carrying its own version
    # literal, so this slot legitimately has nothing to match most of the
    # time -- that is not drift, so it must not fail-close the release.
    update_version_slot "$ROOT_DIR/CLAUDE.md" \
        "s/^(- Current: v)${digits}( )/\\1${new}\\2/" \
        "^- Current: v${new} " \
        "CLAUDE.md Version Numbering" \
        "true"

    update_version_slot "$ROOT_DIR/dashboard/__init__.py" \
        "s/^(__version__ = \")${digits}(\")\$/\\1${new}\\2/" \
        "^__version__ = \"${new}\"\$" \
        "dashboard/__init__.py __version__"

    update_version_slot "$ROOT_DIR/mcp/__init__.py" \
        "s/^(__version__ = ')${digits}(')\$/\\1${new}\\2/" \
        "^__version__ = '${new}'\$" \
        "mcp/__init__.py __version__"

    update_version_slot "$ROOT_DIR/docs/INSTALLATION.md" \
        "s/^(\*\*Version:\*\* v)${digits}\$/\\1${new}/" \
        "^\*\*Version:\*\* v${new}\$" \
        "docs/INSTALLATION.md version header"

    update_version_slot "$ROOT_DIR/wiki/Home.md" \
        "s/^(Current Version: \*\*)${digits}(\*\*)/\\1${new}\\2/" \
        "^Current Version: \*\*${new}\*\*" \
        "wiki/Home.md current version"

    update_version_slot "$ROOT_DIR/wiki/_Sidebar.md" \
        "s/^(\*\*Version:\*\* )${digits}\$/\\1${new}/" \
        "^\*\*Version:\*\* ${new}\$" \
        "wiki/_Sidebar.md version"

    update_version_slot "$ROOT_DIR/wiki/API-Reference.md" \
        "s/^(  \"version\": \")${digits}(\",?)\$/\\1${new}\\2/" \
        "^  \"version\": \"${new}\"" \
        "wiki/API-Reference.md example version"

    update_version_slot "$ROOT_DIR/web-app/src/components/Footer.tsx" \
        "s/^([[:space:]]*v)${digits}\$/\\1${new}/" \
        "^[[:space:]]*v${new}\$" \
        "Footer.tsx version badge"
}

# Files staged into the release commit. Kept as its own list, sourced from
# the same set bump_all_version_files touches, so the commit can never ship
# a partially-bumped tree (some files updated on disk but left unstaged).
RELEASE_COMMIT_FILES="VERSION package.json SKILL.md Dockerfile Dockerfile.sandbox plugins/loki-mode/.claude-plugin/plugin.json server.json CLAUDE.md dashboard/__init__.py mcp/__init__.py docs/INSTALLATION.md wiki/Home.md wiki/_Sidebar.md wiki/API-Reference.md CHANGELOG.md"

# --- Release gate (RELEASE_ON_RED, S-108) --------------------------------
# Founder P0: a release is a lookup of an already-verified commit. Refuses
# (exit 3) unless HEAD's exact SHA has a completed/success run of every
# workflow below. Runs before ANY bump, --bump-only included.
RELEASE_REQUIRED_WORKFLOWS=("Tests" "Bun Parity")

# True (exit 0) iff `gh run list` for $1 at commit $2 contains at least one
# run whose status/conclusion/headSha all match. Parsed with python3 (already
# a hard dependency elsewhere in this repo) instead of jq/grep, since gh's
# --json output is a single compact JSON array and a text match on "success"
# would also match a run on a different SHA or an unrelated field.
_release_gate_run_is_green() {
    local workflow="$1" sha="$2" json rc
    json="$(gh run list --workflow "$workflow" --commit "$sha" \
        --json status,conclusion,headSha 2>/dev/null)"
    rc=$?
    [ "$rc" -eq 0 ] && [ -n "$json" ] || return 1
    python3 -c '
import json, sys
try:
    runs = json.loads(sys.argv[1])
except Exception:
    sys.exit(1)
sha = sys.argv[2]
for r in runs:
    if (r.get("status") == "completed"
            and r.get("conclusion") == "success"
            and r.get("headSha") == sha):
        sys.exit(0)
sys.exit(1)
' "$json" "$sha"
}

require_green_release_gate() {
    local sha wf missing=""

    sha="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null)" || {
        log_error "RELEASE_ON_RED: could not resolve HEAD's SHA"
        exit 3
    }

    if [ "${LOKI_RELEASE_ALLOW_RED:-}" = "1" ]; then
        log_warn "=============================================================="
        log_warn "LOKI_RELEASE_ALLOW_RED=1: SKIPPING the green-CI release gate."
        log_warn "TEST-ONLY ESCAPE HATCH. NEVER set this for a real release."
        log_warn "=============================================================="
        return 0
    fi

    for wf in "${RELEASE_REQUIRED_WORKFLOWS[@]}"; do
        if ! _release_gate_run_is_green "$wf" "$sha"; then
            missing="$missing$wf, "
        fi
    done

    if [ -n "$missing" ]; then
        log_error "RELEASE_ON_RED: refusing to bump. HEAD ($sha) has no"
        log_error "completed/success run for: ${missing%, }"
        log_error "Runs gh found at $sha:"
        for wf in "${RELEASE_REQUIRED_WORKFLOWS[@]}"; do
            log_error "-- $wf --"
            gh run list --workflow "$wf" --commit "$sha" \
                --json status,conclusion,headSha,databaseId,createdAt 2>&1 \
                | sed 's/^/  /' >&2 || true
        done
        exit 3
    fi

    log_success "Release gate: green Tests + Bun Parity run found at $sha"
}

# E-72: loki-ts/dist rebuilds are content-hashed (writeDeterministicDebugId
# in loki-ts/scripts/build.ts) but the hash still shifts across checkouts
# for bundles whose content never depends on VERSION (cockpit.js today).
# On a version-only bump that leaves loki.js/loki.js.map genuinely diffing
# (they embed the version) but cockpit.js/cockpit.js.map diffing in nothing
# but the "//# debugId=" line / the map's "debugId" field -- pure git churn.
# For each *.js/*.map under $1, restore it from HEAD when the ONLY diff is
# that debugId text; files that changed for real (loki.js) are left alone.
release_restore_debugid_only_dist() {
    local dist_dir="$1" file rel head_txt work_txt head_norm work_norm
    local sed_expr='s/(\/\/# debugId=)[0-9A-Fa-f]+/\1X/; s/("debugId"[[:space:]]*:[[:space:]]*")[0-9A-Fa-f]+(")/\1X\2/'

    [ -d "$dist_dir" ] || return 0
    for file in "$dist_dir"/*.js "$dist_dir"/*.map; do
        [ -f "$file" ] || continue
        rel="${file#"$ROOT_DIR"/}"
        head_txt="$(git -C "$ROOT_DIR" show "HEAD:$rel" 2>/dev/null)" || continue
        work_txt="$(cat "$file")"
        [ "$head_txt" = "$work_txt" ] && continue

        head_norm="$(printf '%s' "$head_txt" | sed -E "$sed_expr")"
        work_norm="$(printf '%s' "$work_txt" | sed -E "$sed_expr")"
        if [ "$head_norm" = "$work_norm" ]; then
            git -C "$ROOT_DIR" checkout HEAD -- "$rel"
            log_step "Restored $rel (debugId-only diff)"
        fi
    done
}

# --bump-only (S-108): version files + loki-ts/dist, no git side effects.
run_bump_only() {
    local current new dist_file="$ROOT_DIR/loki-ts/dist/loki.js"

    current=$(get_current_version)
    new=$(bump_version "$current" "$BUMP_TYPE")

    log_step "Bump-only: $current -> $new (no commit, no push)"
    bump_all_version_files "$new"
    log_warn "Not bumped (intentionally, see script header): vscode-extension/package.json (deprecated)"

    if [ -d "$ROOT_DIR/loki-ts" ]; then
        # E-102: fail fast on a missing node_modules instead of letting
        # `bun run build` fail mid-bundle and delete tracked dist files.
        if [ ! -d "$ROOT_DIR/loki-ts/node_modules" ]; then
            log_error "loki-ts/node_modules missing -- run: cd loki-ts && bun install"
            exit 1
        fi
        log_step "Rebuilding loki-ts/dist..."
        if ! ( cd "$ROOT_DIR/loki-ts" && bun run build ); then
            log_error "loki-ts build failed -- restoring loki-ts/dist from HEAD"
            git -C "$ROOT_DIR" checkout -- loki-ts/dist
            exit 1
        fi
        if [ -f "$dist_file" ] && grep -q "$new" "$dist_file"; then
            log_success "loki-ts/dist rebuilt with $new"
            release_restore_debugid_only_dist "$ROOT_DIR/loki-ts/dist"
        else
            log_error "loki-ts/dist rebuild did not embed $new in $dist_file"
            exit 1
        fi
    else
        log_warn "loki-ts/ not found, skipping dist rebuild"
    fi

    echo ""
    log_success "Bump-only complete: v$new"
    echo "Files changed:"
    local f
    for f in $RELEASE_COMMIT_FILES; do
        [ "$f" = "CHANGELOG.md" ] && continue
        echo "  $f"
    done
    [ -d "$ROOT_DIR/loki-ts" ] && echo "  loki-ts/dist/loki.js"
}

# Check for uncommitted changes
check_git_status() {
    if [[ -n "$(git status --porcelain)" ]]; then
        log_warn "You have uncommitted changes:"
        git status --short
        echo ""
        read -r -p "Continue anyway? (y/N) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_error "Aborted"
            exit 1
        fi
    fi
}

# Main release process
main() {
    cd "$ROOT_DIR"

    parse_args "$@"

    # Release gate runs before ANY bump, --bump-only included. Skipped on
    # --dry-run: it makes no changes, so it never needs to pass the "that
    # exact tree is verified" bar.
    if [ "$DRY_RUN" != "true" ]; then
        require_green_release_gate
    fi

    if [ "$BUMP_ONLY" = "true" ]; then
        run_bump_only
        return
    fi

    local current_version
    current_version=$(get_current_version)

    local new_version
    new_version=$(bump_version "$current_version" "$BUMP_TYPE")

    echo ""
    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN}  Loki Mode Release${NC}"
    echo -e "${CYAN}========================================${NC}"
    echo ""
    echo -e "  Current version: ${YELLOW}$current_version${NC}"
    echo -e "  New version:     ${GREEN}$new_version${NC}"
    echo -e "  Bump type:       ${BLUE}$BUMP_TYPE${NC}"
    if [ "$DRY_RUN" = "true" ]; then
        echo -e "  Mode:            ${YELLOW}DRY RUN${NC}"
    fi
    echo ""

    if [ "$DRY_RUN" != "true" ]; then
        read -r -p "Proceed with release? (y/N) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_error "Aborted"
            exit 1
        fi
    else
        log_info "[DRY-RUN] Would proceed with release"
    fi

    # Check git status
    log_step "Checking git status..."
    if [ "$DRY_RUN" != "true" ]; then
        check_git_status
    else
        log_info "[DRY-RUN] Skipping git status check"
    fi

    # Step 1: Update version files
    log_step "Updating version files..."
    bump_all_version_files "$new_version"
    log_warn "Not bumped (intentionally, see script header): vscode-extension/package.json (deprecated)"

    # Step 2: Update changelog
    log_step "Updating CHANGELOG.md..."
    if [ "$DRY_RUN" = "true" ]; then
        log_info "[DRY-RUN] Would run: ./scripts/update-changelog.sh $new_version"
    else
        "$SCRIPT_DIR/update-changelog.sh" "$new_version"
    fi

    # Step 3: Git commit
    log_step "Creating git commit..."
    if [ "$DRY_RUN" = "true" ]; then
        log_info "[DRY-RUN] Would commit: release: v$new_version"
        log_info "[DRY-RUN] Would stage: $RELEASE_COMMIT_FILES"
    else
        # shellcheck disable=SC2086
        git add $RELEASE_COMMIT_FILES
        git commit -m "release: v$new_version"
    fi

    # Step 4: Push
    log_step "Pushing to remote..."
    if [ "$DRY_RUN" = "true" ]; then
        log_info "[DRY-RUN] Would push to origin main"
    else
        git push origin main
    fi

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  Release v$new_version initiated!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo "GitHub Actions will now:"
    echo "  1. Create git tag v$new_version"
    echo "  2. Create GitHub Release"
    echo "  3. Publish to npm"
    echo "  4. Build and push Docker image"
    echo "  5. Update Homebrew tap"
    echo ""
    echo "Watch progress:"
    echo "  gh run list --workflow=Release --limit 1"
    echo "  gh run watch"
    echo ""
}

# Allow this script to be sourced (e.g. by tests) without running main.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
