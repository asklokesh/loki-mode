#!/usr/bin/env bash
#
# release.sh - Automated release script for Loki Mode
#
# Usage:
#   ./scripts/release.sh patch|minor|major [--dry-run]
#   ./scripts/release.sh patch|minor|major --bump-only
#   ./scripts/release.sh [patch|minor|major] --ship --notes FILE
#
# --ship: the release recipe as one command. Runs
# the same release gate, then preflights (notes header is '## v<new>',
# the first '## v' CHANGELOG header is '## v<current>', origin/main is an ancestor of HEAD),
# bumps, inserts the notes as the new CHANGELOG section, rebuilds dist,
# stages by name (refusing CONTROL.md, usage-readings.tsv, bun.lock, out2.txt
# and .claude/providers.ts), commits as asklokesh, re-checks ancestry, runs
# gitleaks on origin/main..HEAD, waits up to 300s for an in-flight Release
# run, pushes with LOKI_RELEASE_MANAGER=1 and verifies HEAD == origin/main.
# Prints a [TIME] line per phase. Every refusal exits 4 before the push.
#
# This script:
#   1. Bumps version in every file CLAUDE.md's "Release Workflow" section 1
#      lists (see FILES_TO_BUMP below), except the ones documented as
#      intentionally left to the maintainer.
#   2. Updates CHANGELOG.md from conventional commits
#   3. Commits and pushes (triggers GitHub Actions release workflow)
#
# --bump-only: bumps
# every version file plus loki-ts/dist, then exits. No prompt, no git add,
# no commit, no push -- run this instead of hand-editing
# VERSION, then commits the result itself.
#
# RELEASE GATE: before ANY bump (this includes --bump-only) the global guard
# rows (scripts/global-guards.tsv) run against a clean worktree of HEAD; a red
# row refuses the bump, exit 3 (RELEASE_GUARD_RED). No workflow run is required:
# publishing never waits on a test job. --dry-run skips the gate since it
# writes nothing. No environment variable skips the rows.
#
# Files intentionally NOT bumped by this script (left to the maintainer):
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
CHECK_CLEAN="false"
SHIP="false"
SHIP_NOTES=""
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
            --check-clean)
                CHECK_CLEAN="true"
                ;;
            --ship)
                SHIP="true"
                ;;
            --notes)
                if [[ $# -lt 2 ]]; then
                    log_error "--notes needs a FILE"
                    exit 1
                fi
                SHIP_NOTES="$2"
                shift
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

    if [ "$SHIP" = "true" ]; then
        [ -n "$BUMP_TYPE" ] || BUMP_TYPE="patch"
        if [ "$DRY_RUN" = "true" ] || [ "$BUMP_ONLY" = "true" ]; then
            log_error "--ship cannot be combined with --dry-run or --bump-only"
            exit 1
        fi
        if [ -z "$SHIP_NOTES" ] || [ ! -s "$SHIP_NOTES" ]; then
            log_error "--ship needs --notes FILE (an existing, non-empty file)"
            exit 1
        fi
        SHIP_NOTES="$(cd "$(dirname -- "$SHIP_NOTES")" && pwd)/$(basename -- "$SHIP_NOTES")"
    elif [ -n "$SHIP_NOTES" ]; then
        log_error "--notes is only valid with --ship"
        exit 1
    fi

    if [[ -z "$BUMP_TYPE" && "$CHECK_CLEAN" != "true" ]]; then
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
  --check-clean  Run after the release commit: exit 1 naming any tracked file
               still modified (E-151: a stamped dist map left out of the commit).
  --ship --notes FILE
               One-command ship (bump type defaults to patch): bump, insert FILE
               as the new CHANGELOG section, rebuild dist, commit, check
               ancestry and gitleaks, wait (max 300s) for an in-flight Release
               run, push origin HEAD:main and verify. Refusals exit 4 (SHIP_*).
  -h, --help   Show this help message

Examples:
  $(basename "$0") patch          # 5.8.2 -> 5.8.3
  $(basename "$0") minor          # 5.8.2 -> 5.9.0
  $(basename "$0") major          # 5.8.2 -> 6.0.0
  $(basename "$0") patch --dry-run
  $(basename "$0") patch --bump-only
  $(basename "$0") --ship --notes /path/to/notes.md
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

    update_version_slot "$ROOT_DIR/docker/Dockerfile" \
        "s/^(LABEL version=\")${digits}(\")\$/\\1${new}\\2/" \
        "^LABEL version=\"${new}\"\$" \
        "Dockerfile LABEL version"

    update_version_slot "$ROOT_DIR/docker/Dockerfile" \
        "s/^(LABEL org\.opencontainers\.image\.version=\")${digits}(\")\$/\\1${new}\\2/" \
        "^LABEL org\.opencontainers\.image\.version=\"${new}\"\$" \
        "Dockerfile LABEL org.opencontainers.image.version"

    update_version_slot "$ROOT_DIR/docker/Dockerfile.sandbox" \
        "s/^(LABEL version=\")${digits}(\")\$/\\1${new}\\2/" \
        "^LABEL version=\"${new}\"\$" \
        "Dockerfile.sandbox LABEL version"

    update_version_slot "$ROOT_DIR/docker/Dockerfile.sandbox" \
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
    # now points at VERSION instead of carrying its own version
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

    update_version_slot "$ROOT_DIR/web-app/src/components/WhatsNew.tsx" \
        "s/^(const CURRENT_VERSION = ')${digits}(';)\$/\\1${new}\\2/" \
        "^const CURRENT_VERSION = '${new}';\$" \
        "WhatsNew.tsx CURRENT_VERSION"

    # STALE-ZERO SZ-01: regenerate README facts, SKILL.md command list, Helm
    # appVersion and the CLI reference from VERSION and the command registry.
    if [ -x "$ROOT_DIR/scripts/generate-stale-zero.sh" ]; then
        (cd "$ROOT_DIR" && "$ROOT_DIR/scripts/generate-stale-zero.sh")
    else
        log_warn "scripts/generate-stale-zero.sh not found under $ROOT_DIR; skipping generated facts"
    fi
}

# Files staged into the release commit. Kept as its own list, sourced from
# the same set bump_all_version_files touches, so the commit can never ship
# a partially-bumped tree (some files updated on disk but left unstaged).
# Dist files a release commit stages.
RELEASE_DIST_FILES="loki-ts/dist/loki.js loki-ts/dist/loki.js.map"
RELEASE_COMMIT_FILES="VERSION package.json SKILL.md docker/Dockerfile docker/Dockerfile.sandbox plugins/loki-mode/.claude-plugin/plugin.json server.json CLAUDE.md dashboard/__init__.py mcp/__init__.py docs/INSTALLATION.md wiki/Home.md wiki/_Sidebar.md wiki/API-Reference.md web-app/src/components/Footer.tsx web-app/src/components/WhatsNew.tsx README.md helm/loki-mode/Chart.yaml deploy/helm/autonomi/Chart.yaml deploy/helm/control-plane/Chart.yaml docs/CLI-REFERENCE.md docs/CLI-INVENTORY.md CHANGELOG.md"

# --- Release gate ---------------------------------------------------------
# Workflow names whose failed run at the cut SHA refuses a release. Empty until
# the PR fast tier refusal signal lands. Every name here must match a `name:` in
# .github/workflows/*.yml (tests/test-workflow-no-masked-failures.sh, R6).
# shellcheck disable=SC2034
RELEASE_REQUIRED_WORKFLOWS=()

# Cheap CI-only guards (global-guards.tsv R8 rows). Always run before a bump
# so a release cannot cut on a tree a guard already rejects. Same runner as the
# impacted gate (scripts/impacted-gate.sh --guards-only): per-row timeout, parallel.
# No environment variable skips them. LOKI_RELEASE_GUARD_TIMEOUT (default 900s)
# is the per-row limit. Guards run in a clean worktree of HEAD; a worktree failure exits 3.
run_release_guard_rows() {
    local out rc=0 started
    # The guards read the working tree, so run them in a clean detached worktree of
    # HEAD: the main checkout is dirty by design (usage-governor appends to tracked files).
    local tmp_root dir wt
    tmp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || {
        log_error "RELEASE_GUARD_RED: cannot resolve the temp root"
        exit 3
    }
    # Sweep guard worktrees an interrupted release (SIGTERM) left registered. Only
    # entries at <temp root>/loki-guard.*/guard-wt qualify; the parent is removed
    # only if it is a real (non-symlink) loki-guard.* dir under the temp root.
    local line stale_wt stale_dir
    while IFS= read -r line; do
        case "$line" in
            "worktree ${tmp_root}"/loki-guard.*/guard-wt) ;;
            *) continue ;;
        esac
        stale_wt="${line#worktree }"
        stale_dir="$(dirname -- "$stale_wt")"
        # Only a direct child of the temp root: no extra slash or .. component.
        case "${stale_dir#"${tmp_root}"/}" in
            */* | *..*) continue ;;
        esac
        git -C "$ROOT_DIR" worktree remove --force "$stale_wt" >/dev/null 2>&1 || true
        case "$stale_dir" in
            "${tmp_root}"/loki-guard.*)
                if [ -d "$stale_dir" ] && [ ! -L "$stale_dir" ]; then rm -rf -- "$stale_dir"; fi ;;
        esac
    done < <(git -C "$ROOT_DIR" worktree list --porcelain 2>/dev/null)
    git -C "$ROOT_DIR" worktree prune >/dev/null 2>&1 || true
    dir="$(mktemp -d "${tmp_root}/loki-guard.XXXXXXXX")" || {
        log_error "RELEASE_GUARD_RED: cannot create the guard temp dir"
        exit 3
    }
    chmod 700 "$dir" || {
        log_error "RELEASE_GUARD_RED: cannot chmod 700 the guard temp dir"
        rmdir "$dir" 2>/dev/null || true
        exit 3
    }
    wt="$dir/guard-wt"
    if ! git -C "$ROOT_DIR" worktree add --detach "$wt" HEAD >/dev/null 2>&1; then
        git -C "$ROOT_DIR" worktree remove --force "$wt" >/dev/null 2>&1 || true
        rm -rf -- "$dir"
        log_error "RELEASE_GUARD_RED: could not create a clean worktree of HEAD for the guard rows"
        exit 3
    fi
    # bun rows need deps; node_modules is untracked so the clean worktree lacks it.
    if [ -d "$ROOT_DIR/loki-ts/node_modules" ] && [ ! -e "$wt/loki-ts/node_modules" ] && [ -d "$wt/loki-ts" ]; then
        ln -s "$ROOT_DIR/loki-ts/node_modules" "$wt/loki-ts/node_modules" || true
    fi
    log_step "Running global guard rows against a clean worktree of HEAD (scripts/impacted-gate.sh --guards-only)..."
    started="$(date +%s)"
    # env -u: a caller-exported LOKI_RUN_TMP would make the gate's loki_run_tmp_create refuse.
    out="$(cd "$wt" && env -u LOKI_RUN_TMP IMPACTED_SUITE_TIMEOUT="${LOKI_RELEASE_GUARD_TIMEOUT:-900}" \
        bash "$wt/scripts/impacted-gate.sh" --guards-only 2>&1)" || rc=$?
    git -C "$ROOT_DIR" worktree remove --force "$wt" >/dev/null 2>&1 || true
    case "$dir" in
        "${tmp_root}"/loki-guard.*) if [ ! -L "$dir" ]; then rm -rf -- "$dir"; fi ;;
    esac
    git -C "$ROOT_DIR" worktree prune >/dev/null 2>&1 || true
    printf '%s\n' "$out"
    log_info "Guard rows took $(( $(date +%s) - started ))s"
    if [ "$rc" -ne 0 ]; then
        log_error "RELEASE_GUARD_RED: a global guard row failed; refusing to bump."
        printf '%s\n' "$out" | grep -E '^rc=[0-9]+ ' | grep -v '^rc=0 ' | sed 's/^/  red row: /' >&2 || true
        exit 3
    fi
    log_success "Global guard rows green"
}

# loki-ts/dist rebuilds are content-hashed (writeDeterministicDebugId
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

    # a .js file left alone above (it has a REAL diff, e.g. the
    # version literal) can still have picked up a fresh "//# debugId="
    # trailer from the rebuild, even though its .map companion was just
    # restored to HEAD verbatim by the loop above. Shipping that pair
    # leaves loki.js and loki.js.map carrying two different debugIds.
    # Whenever a .map is now byte-identical to HEAD, restore only its
    # companion .js's trailer line to HEAD's value too (the real diff
    # elsewhere in the .js stays untouched), so the pair matches again.
    local map_file js_file head_id tmp_js
    for map_file in "$dist_dir"/*.js.map; do
        [ -f "$map_file" ] || continue
        js_file="${map_file%.map}"
        [ -f "$js_file" ] || continue

        rel="${map_file#"$ROOT_DIR"/}"
        head_txt="$(git -C "$ROOT_DIR" show "HEAD:$rel" 2>/dev/null)" || continue
        work_txt="$(cat "$map_file")"
        [ "$head_txt" = "$work_txt" ] || continue

        rel="${js_file#"$ROOT_DIR"/}"
        head_txt="$(git -C "$ROOT_DIR" show "HEAD:$rel" 2>/dev/null)" || continue
        head_id="$(printf '%s\n' "$head_txt" | grep -E -o '^//# debugId=[0-9A-Fa-f]+$' | tail -n1)"
        [ -n "$head_id" ] || continue
        grep -qF "$head_id" "$js_file" && continue

        tmp_js="$(mktemp "${js_file}.XXXXXX")" || continue
        if sed -E "s|^//# debugId=[0-9A-Fa-f]+\$|${head_id}|" "$js_file" >"$tmp_js"; then
            mv "$tmp_js" "$js_file"
            log_step "Restored $rel debugId trailer to match HEAD (paired with restored .map)"
        else
            rm -f "$tmp_js"
        fi
    done
}

# shared by both run_bump_only failure branches below -- restores
# loki-ts/dist from HEAD, logs why, and exits non-zero. A build that exits 0
# without embedding the new version is the same "don't ship a stale/broken
# dist" case as a build that fails outright, so both routes through here.
release_bump_only_fail() {
    log_error "$1"
    git -C "$ROOT_DIR" checkout -- loki-ts/dist
    exit 1
}

# refuse a dist whose source maps carry a machine-local path. A
# node_modules symlink to another checkout made the v10.5.4 build write 133
# absolute /Users/... "sources" entries. Reads the maps as JSON so comment
# text inside sourcesContent cannot trip it. Relative entries resolve against
# loki-ts/dist; one that lands outside the repo root counts as climbing out.
release_dist_maps_clean() {
    python3 - "$ROOT_DIR" "$ROOT_DIR/loki-ts/dist" <<'PY'
import glob, json, os, sys
root, dist = os.path.realpath(sys.argv[1]), os.path.realpath(sys.argv[2])
bad = []
for m in sorted(glob.glob(os.path.join(dist, "*.map"))):
    for s in json.load(open(m)).get("sources") or []:
        r = os.path.normpath(os.path.join(dist, s))
        if os.path.isabs(s) or os.path.commonpath([root, r]) != root:
            bad.append((os.path.basename(m), s))
for f, s in bad[:5]:
    print("  %s: %s" % (f, s), file=sys.stderr)
if bad:
    print("  %d bad source entries in total" % len(bad), file=sys.stderr)
sys.exit(1 if bad else 0)
PY
}

# after the release commit no tracked file may still differ from HEAD.
# dist is tracked, so a plain `git add <file>` suffices for a leftover map.
release_commit_clean() {
    local dirty
    dirty=$(git -C "${ROOT_DIR}" status --porcelain --untracked-files=no | sed 's/^...//')
    [ -z "$dirty" ] && return 0
    echo "release commit left tracked files modified (stage and amend):" >&2
    echo "$dirty" | sed 's/^/  /' >&2
    return 1
}

# --bump-only: version files + loki-ts/dist, no git side effects.
run_bump_only() {
    local current new

    current=$(get_current_version)
    new=$(bump_version "$current" "$BUMP_TYPE")

    log_step "Bump-only: $current -> $new (no commit, no push)"
    bump_all_version_files "$new"
    log_warn "Not bumped (intentionally, see script header): vscode-extension/package.json (deprecated)"
    release_rebuild_dist "$new"

    echo ""
    log_success "Bump-only complete: v$new"
    echo "stage these files:"
    release_stage_lines
}

# Rebuild loki-ts/dist and require it to embed $1. Shared by --bump-only and
# --ship. On failure loki-ts/dist is restored from HEAD and the script exits 1.
release_rebuild_dist() {
    local new="$1" dist_file="$ROOT_DIR/loki-ts/dist/loki.js"
    if [ -d "$ROOT_DIR/loki-ts" ]; then
        # fail fast on a missing node_modules instead of letting
        # `bun run build` fail mid-bundle and delete tracked dist files.
        if [ ! -d "$ROOT_DIR/loki-ts/node_modules" ]; then
            log_error "loki-ts/node_modules missing -- run: cd loki-ts && bun install"
            exit 1
        fi
        log_step "Rebuilding loki-ts/dist..."
        if ! ( cd "$ROOT_DIR/loki-ts" && bun run build ); then
            release_bump_only_fail "loki-ts build failed -- restoring loki-ts/dist from HEAD"
        fi
        if [ -f "$dist_file" ] && grep -q "$new" "$dist_file"; then
            if ! release_dist_maps_clean; then
                release_bump_only_fail "loki-ts/dist source maps contain absolute or repo-escaping paths (is loki-ts/node_modules a symlink to another checkout?) -- restoring loki-ts/dist from HEAD"
            fi
            log_success "loki-ts/dist rebuilt with $new"
            release_restore_debugid_only_dist "$ROOT_DIR/loki-ts/dist"
        else
            release_bump_only_fail "loki-ts/dist rebuild did not embed $new in $dist_file -- restoring loki-ts/dist from HEAD"
        fi
    else
        log_warn "loki-ts/ not found, skipping dist rebuild"
    fi
}

# one `git add` line per modified tracked file; `-f` when the path sits
# under an ignored directory (a tracked-but-ignored dist needs it).
release_stage_lines() {
    local f
    git -C "$ROOT_DIR" status --porcelain --untracked-files=no | sed 's/^...//' | while IFS= read -r f; do
        if git -C "$ROOT_DIR" check-ignore --no-index -q -- "$f"; then
            echo "  git add -f $f"
        else
            echo "  git add $f"
        fi
    done
}

# --- --ship ----------------------------------------
# One-command ship: bump, CHANGELOG section from --notes FILE, dist rebuild,
# commit, ancestry + gitleaks checks, bounded wait for an in-flight Release
# run, push, verify. Every refusal exits 4 with a SHIP_* token and happens
# before the push. A refusal after the commit leaves the local commit in place
# (nothing is reset); the message says so.
SHIP_REMOTE="origin"
SHIP_FORBIDDEN_STAGED="docs/v10/CONTROL.md docs/v10/usage-readings.tsv bun.lock out2.txt .claude/providers.ts"
# Tracked inputs of `bun run build`. A working-tree edit here would be bundled
# into the committed dist, so it must match HEAD like the release files do.
# loki-ts/dist itself is not listed: the build regenerates it wholesale.
SHIP_BUILD_INPUTS="loki-ts/src loki-ts/scripts loki-ts/data loki-ts/package.json loki-ts/tsconfig.json loki-ts/bun.lock loki-ts/bunfig.toml"
SHIP_PHASE_NAME=""
SHIP_PHASE_START=0
SHIP_T0=0
SHIP_COMMITTED=""

# Tracked files under the generator's declared outputs that differ from HEAD.
ship_generator_dirty() {
    local specs
    [ -x "$ROOT_DIR/scripts/generate-stale-zero.sh" ] || return 0
    specs="$("$ROOT_DIR/scripts/generate-stale-zero.sh" --outputs)" || return 0
    # shellcheck disable=SC2086 # pathspecs contain no spaces
    git -C "$ROOT_DIR" diff --name-only HEAD -- $specs
}

ship_refuse() {
    log_error "$1: $2"
    if [ -n "$SHIP_COMMITTED" ]; then
        log_error "The local release commit $SHIP_COMMITTED was NOT pushed and is left in place."
    fi
    exit 4
}

# A linked worktree has a git-dir distinct from the common dir. --ship pushes,
# and the pre-push hook refuses pushes from linked worktrees, so refuse up
# front, before any VERSION edit or commit, and name the main checkout.
ship_require_main_checkout() {
    local gd gcd
    gd="$(cd "$(git -C "$ROOT_DIR" rev-parse --git-dir)" && pwd -P)" || return 0
    gcd="$(cd "$(git -C "$ROOT_DIR" rev-parse --git-common-dir)" && pwd -P)" || return 0
    [ "$gd" != "$gcd" ] || return 0
    ship_refuse SHIP_LINKED_WORKTREE "--ship cannot run from a linked worktree ($ROOT_DIR). Run it from the main checkout: $(dirname -- "$gcd")"
}

# Close the running phase (printing its [TIME] line) and open phase $1.
ship_phase() {
    local now
    now="$(date +%s)"
    if [ -n "$SHIP_PHASE_NAME" ]; then
        echo "[TIME] $SHIP_PHASE_NAME: $((now - SHIP_PHASE_START))s"
    fi
    SHIP_PHASE_NAME="$1"
    SHIP_PHASE_START="$now"
    if [ -n "$1" ]; then log_step "ship: $1"; fi
}

# Print the line number of the first '## v' header in file $1 (the newest
# section, wherever the preamble ends). Exit 1 and print nothing if none.
ship_changelog_top_line() {
    local n
    n="$(awk '/^## v/ { print NR; exit }' "$1" 2>/dev/null)"
    [ -n "$n" ] || return 1
    printf '%s\n' "$n"
}

# Exit 0 iff line $2 of file $1 is the section header of exactly version $3:
# "## v<ver>" followed by a space or end of line. A prefix match would accept
# "## v1.2.30" for 1.2.3, so the version token is compared whole.
ship_header_is() {
    local file="$1" lineno="$2" want="$3" line tok
    line="$(sed -n "${lineno}p" "$file" 2>/dev/null)"
    case "$line" in
        "## v"*) ;;
        *) return 1 ;;
    esac
    tok="${line#"## v"}"
    tok="${tok%% *}"
    [ "$tok" = "$want" ]
}

# Exit 0 iff scripts/release-notes.sh accepts $1 as the notes of version $2.
ship_check_notes_format() {
    (cd "$ROOT_DIR" && bash scripts/release-notes.sh "$2" --file "$1" >/dev/null 2>&1)
}

# Insert the notes file as the new top section immediately before the first
# '## v' header (any preamble is kept as is), dropping its trailing blank lines
# and keeping exactly one blank line before the previous section.
ship_write_changelog() {
    local notes="$1" cl="$ROOT_DIR/CHANGELOG.md" tmp top
    top="$(ship_changelog_top_line "$cl")" || return 1
    tmp="$(mktemp "${cl}.XXXXXX")" || return 1
    cp -p "$cl" "$tmp"
    if {
        awk -v t="$top" 'NR < t' "$cl"
        sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$notes"
        echo ""
        sed -n "${top},\$p" "$cl"
    } >"$tmp"; then
        mv "$tmp" "$cl"
    else
        rm -f "$tmp"
        return 1
    fi
}

ship_fetch_main() {
    git -C "$ROOT_DIR" fetch -q "$SHIP_REMOTE" \
        "+refs/heads/main:refs/remotes/$SHIP_REMOTE/main"
}

ship_require_ancestor() {
    ship_fetch_main || ship_refuse SHIP_FETCH_FAILED "git fetch $SHIP_REMOTE main failed"
    if ! git -C "$ROOT_DIR" merge-base --is-ancestor "refs/remotes/$SHIP_REMOTE/main" HEAD; then
        ship_refuse SHIP_NOT_ANCESTOR "$SHIP_REMOTE/main ($(git -C "$ROOT_DIR" rev-parse --short "refs/remotes/$SHIP_REMOTE/main")) is not an ancestor of HEAD; rebase onto it first"
    fi
}

# Exit 0 iff gh lists no Release run that is still queued or running.
# A gh failure counts as busy, so the bounded wait then refuses.
ship_release_idle() {
    local json
    json="$(gh run list --workflow Release --limit 20 --json status,databaseId 2>/dev/null)" || return 1
    python3 -c '
import json, sys
try:
    runs = json.loads(sys.argv[1])
except Exception:
    sys.exit(1)
sys.exit(1 if any(r.get("status") != "completed" for r in runs) else 0)
' "$json"
}

run_ship() {
    local notes="$SHIP_NOTES" current new f staged hit waited dirty cl_top
    local max_wait="${LOKI_RELEASE_SHIP_WAIT:-300}" poll="${LOKI_RELEASE_SHIP_POLL:-10}"
    case "$max_wait" in '' | *[!0-9]*) max_wait=300 ;; esac
    case "$poll" in '' | *[!0-9]* | 0) poll=10 ;; esac
    [ "$max_wait" -le 300 ] || max_wait=300

    SHIP_T0="$(date +%s)"
    current=$(get_current_version)
    new=$(bump_version "$current" "$BUMP_TYPE")

    # Every check that needs no write runs before the first write.
    ship_phase "preflight ($current -> $new)"
    command -v gitleaks >/dev/null 2>&1 || ship_refuse SHIP_NO_GITLEAKS "gitleaks is not on PATH"
    ship_header_is "$notes" 1 "$new" \
        || ship_refuse SHIP_NOTES_HEADER "the first line of $notes must be '## v$new ...'"
    # FC-RELEASE-NOTES-FORMAT-UNCHECKED-LOCALLY: CI's release-notes.sh rejects a section
    # with no '### ' subsection AFTER npm has published, skipping the tag and GitHub
    # release. Run the same validator on the notes before any write. Not bypassable.
    ship_check_notes_format "$notes" "$new" \
        || ship_refuse SHIP_NOTES_FORMAT "release-notes.sh rejects the notes in $notes (needs '### ' subsections and '- ' bullets)"
    cl_top="$(ship_changelog_top_line "$ROOT_DIR/CHANGELOG.md")" \
        || ship_refuse SHIP_CHANGELOG_NO_HEADER "CHANGELOG.md has no '## v' section header"
    ship_header_is "$ROOT_DIR/CHANGELOG.md" "$cl_top" "$current" \
        || ship_refuse SHIP_CHANGELOG_MISMATCH "CHANGELOG.md line $cl_top is '$(sed -n "${cl_top}p" "$ROOT_DIR/CHANGELOG.md" 2>/dev/null)', expected '## v$current'"
    # The release commit may hold only HEAD plus this run's own edits. Refuse
    # an index that already has anything staged, and any release file or
    # build input that differs from HEAD (another agent's unreviewed edit in
    # the shared checkout would otherwise ride the release to main and npm).
    if ! git -C "$ROOT_DIR" diff --cached --quiet; then
        ship_refuse SHIP_INDEX_NOT_EMPTY "already staged: $(git -C "$ROOT_DIR" diff --cached --name-only | tr '\n' ' ')(unstage with git restore --staged)"
    fi
    # shellcheck disable=SC2086 # word-split path lists on purpose
    dirty="$(git -C "$ROOT_DIR" diff --name-only HEAD -- $RELEASE_COMMIT_FILES $SHIP_BUILD_INPUTS)"
    [ -z "$dirty" ] || ship_refuse SHIP_DIRTY_RELEASE_FILES "differ from HEAD: $(printf '%s' "$dirty" | tr '\n' ' ') (commit them through review or git restore them)"
    ship_require_ancestor

    ship_phase "bump version files"
    # Tracked generator outputs already dirty before the bump are the user's own
    # edits: they are never staged and never counted as release-produced.
    ship_gen_pre_dirty="$(ship_generator_dirty)"
    bump_all_version_files "$new"
    ship_gen_changed=""
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        printf '%s\n' "$ship_gen_pre_dirty" | grep -qxF -- "$f" && continue
        case " $RELEASE_COMMIT_FILES " in *" $f "*) continue ;; esac
        ship_gen_changed="$ship_gen_changed $f"
    done <<<"$(ship_generator_dirty)"

    ship_phase "write CHANGELOG section"
    ship_write_changelog "$notes" || ship_refuse SHIP_CHANGELOG_WRITE "could not write CHANGELOG.md"
    cl_top="$(ship_changelog_top_line "$ROOT_DIR/CHANGELOG.md")" \
        || ship_refuse SHIP_CHANGELOG_NO_HEADER "CHANGELOG.md has no '## v' section header after the insert"
    ship_header_is "$ROOT_DIR/CHANGELOG.md" "$cl_top" "$new" \
        || ship_refuse SHIP_CHANGELOG_MISMATCH "CHANGELOG.md line $cl_top is '$(sed -n "${cl_top}p" "$ROOT_DIR/CHANGELOG.md" 2>/dev/null)', expected '## v$new' after the insert"
    ship_check_notes_format "$ROOT_DIR/CHANGELOG.md" "$new" \
        || ship_refuse SHIP_NOTES_FORMAT "release-notes.sh rejects the written CHANGELOG.md section for v$new"

    ship_phase "rebuild loki-ts/dist"
    release_rebuild_dist "$new"

    ship_phase "stage and commit"
    for f in $RELEASE_COMMIT_FILES; do
        if [ -e "$ROOT_DIR/$f" ]; then git -C "$ROOT_DIR" add -- "$f"; fi
    done
    # Files the generator rewrote beyond the fixed list (for example every wiki
    # page carrying the version stamp), staged by name.
    for f in $ship_gen_changed; do
        git -C "$ROOT_DIR" add -- "$f"
    done
    for f in $RELEASE_DIST_FILES; do
        [ -f "$ROOT_DIR/$f" ] || ship_refuse SHIP_DIST_MISSING "$f does not exist after the build"
        git -C "$ROOT_DIR" add -f -- "$f"
    done
    # No pipe into grep -q: under pipefail, grep exiting on its first match SIGPIPEs the still-writing git show (rc 141)
    # on a multi-MB bundle, which read as "does not embed" (v11.17.60 ship). A here-string reads the blob in full.
    grep -qF -- "$new" <<<"$(git -C "$ROOT_DIR" show ":loki-ts/dist/loki.js")" \
        || ship_refuse SHIP_DIST_STALE "staged loki-ts/dist/loki.js does not embed $new"
    staged="$(git -C "$ROOT_DIR" diff --cached --name-only)"
    hit=""
    for f in $SHIP_FORBIDDEN_STAGED; do
        if printf '%s\n' "$staged" | grep -qxF -- "$f"; then hit="$hit $f"; fi
    done
    [ -z "$hit" ] || ship_refuse SHIP_FORBIDDEN_STAGED "refusing to commit:$hit (unstage with git restore --staged)"
    # Allowlist: every staged path must be a release file or the dist pair.
    hit=""
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        case " $RELEASE_COMMIT_FILES$ship_gen_changed loki-ts/dist/loki.js loki-ts/dist/loki.js.map " in
            *" $f "*) ;;
            *) hit="$hit $f" ;;
        esac
    done <<<"$staged"
    [ -z "$hit" ] || ship_refuse SHIP_UNEXPECTED_STAGED "not a release file:$hit (unstage with git restore --staged)"
    # Commit exactly the validated paths, so a file staged after this check
    # by another process in the shared checkout still stays out.
    # shellcheck disable=SC2086 # release paths contain no spaces
    git -C "$ROOT_DIR" -c user.name=asklokesh -c user.email=lokeshmure@live.com \
        commit -q -m "release: v$new" -- $staged || ship_refuse SHIP_COMMIT_FAILED "git commit failed"
    SHIP_COMMITTED="$(git -C "$ROOT_DIR" rev-parse HEAD)"
    if [ -n "$(git -C "$ROOT_DIR" diff --name-only HEAD -- VERSION CHANGELOG.md loki-ts/dist/loki.js loki-ts/dist/loki.js.map)" ]; then
        ship_refuse SHIP_DIRTY_AFTER_COMMIT "release files still differ from the commit"
    fi
    # Anything the generator changed that the commit did not take is a
    # release-produced file left modified; pre-existing dirt is excluded.
    left=""
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        printf '%s\n' "$ship_gen_pre_dirty" | grep -qxF -- "$f" && continue
        left="$left $f"
    done <<<"$(ship_generator_dirty)"
    [ -z "$left" ] || ship_refuse SHIP_DIRTY_AFTER_COMMIT "release left generated files modified:$left"

    ship_phase "ancestry check"
    ship_require_ancestor

    ship_phase "gitleaks"
    # gitleaks auto-loads <target>/.gitleaks.toml, so a range that adds
    # or edits it could disable the scan of that same range. Refuse it here.
    if [ -n "$(git -C "$ROOT_DIR" diff --name-only "refs/remotes/$SHIP_REMOTE/main" HEAD -- .gitleaks.toml)" ]; then
        ship_refuse SHIP_GITLEAKS_CONFIG "$SHIP_REMOTE/main..HEAD changes .gitleaks.toml; that needs its own reviewed PR"
    fi
    local -a leak_ignore=()
    if [ -f "$ROOT_DIR/.gitleaksignore" ]; then
        leak_ignore=(--gitleaks-ignore-path "$ROOT_DIR/.gitleaksignore")
    fi
    if ! gitleaks git --no-banner --redact "${leak_ignore[@]+"${leak_ignore[@]}"}" \
        --log-opts="$SHIP_REMOTE/main..HEAD --diff-merges=first-parent" "$ROOT_DIR"; then
        ship_refuse SHIP_GITLEAKS "gitleaks reported a finding (or failed) on $SHIP_REMOTE/main..HEAD"
    fi

    ship_phase "wait for an in-flight Release run (max ${max_wait}s)"
    waited=0
    until ship_release_idle; do
        if [ "$waited" -ge "$max_wait" ]; then
            ship_refuse SHIP_RELEASE_BUSY "a Release run is still in flight (or gh failed) after ${waited}s"
        fi
        log_info "Release run in flight; waiting ${poll}s (${waited}s/${max_wait}s)"
        sleep "$poll"
        waited=$((waited + poll))
    done

    ship_phase "push"
    LOKI_RELEASE_MANAGER=1 git -C "$ROOT_DIR" push -q "$SHIP_REMOTE" HEAD:refs/heads/main \
        || ship_refuse SHIP_PUSH_FAILED "git push $SHIP_REMOTE HEAD:refs/heads/main failed"

    ship_phase "verify $SHIP_REMOTE/main"
    ship_fetch_main || ship_refuse SHIP_FETCH_FAILED "post-push fetch failed"
    if [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" != "$(git -C "$ROOT_DIR" rev-parse "refs/remotes/$SHIP_REMOTE/main")" ]; then
        ship_refuse SHIP_PUSH_UNVERIFIED "HEAD does not equal $SHIP_REMOTE/main after the push"
    fi
    ship_phase ""
    echo "[TIME] total: $(( $(date +%s) - SHIP_T0 ))s"
    log_success "Shipped v$new ($SHIP_COMMITTED) to $SHIP_REMOTE/main"
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

    if [ "$CHECK_CLEAN" = "true" ]; then
        release_commit_clean
        return
    fi

    if [ "$SHIP" = "true" ]; then
        ship_require_main_checkout
    fi

    # The guard rows run before ANY bump, --bump-only included. Skipped on
    # --dry-run: it makes no changes, so it never needs to pass the "that
    # exact tree is verified" bar.
    if [ "$DRY_RUN" != "true" ]; then
        run_release_guard_rows
    fi

    if [ "$BUMP_ONLY" = "true" ]; then
        run_bump_only
        return
    fi

    if [ "$SHIP" = "true" ]; then
        run_ship
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
