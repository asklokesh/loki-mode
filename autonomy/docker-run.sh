#!/usr/bin/env bash
#===============================================================================
# Loki Mode - zero-friction Docker host wrapper
#
# Lets a user run loki inside the published Docker image with the SAME
# experience as the local CLI: run it in a project folder and it just works.
# .loki/ state (memory, session, queue, checkpoints) persists via the workspace
# bind mount, so resume and continuity behave exactly like `loki start` on the
# host.
#
# Auth precedence (zero config for Claude Code subscribers):
#   1. ANTHROPIC_API_KEY set in the environment  -> passed through (explicit).
#   2. else host Claude Code login auto-detected  -> credentials extracted to a
#      per-run temp copy and mounted read-write so the in-container claude can
#      refresh the short-lived token for the duration of the run. Each run
#      re-extracts a fresh token from the host store, so a long-idle token is
#      never an issue. (The temp copy is wiped on exit; refreshes are not written
#      back to the host store, which is why per-run re-extraction matters.)
#   3. else                                        -> honest error with guidance.
#
# Token handling: the extracted credentials file is written to a private temp
# path (0600) and removed on exit. It is NEVER written into the project, never
# committed, never logged.
#
# Sourced by autonomy/loki (cmd_docker). Also runnable standalone for tests:
#   loki_docker_detect_auth   -> prints: apikey | oauth | none
#   loki_docker_extract_creds <dest>  -> writes host OAuth creds to <dest>
#   loki_docker_build_argv ...        -> prints the docker argv it would run
#===============================================================================

# Default image. Overridable for local builds / pinning.
: "${LOKI_DOCKER_IMAGE:=asklokesh/loki-mode:latest}"
# In-container path claude reads OAuth credentials from (Linux, no keychain).
_LOKI_DOCKER_CRED_DEST="/home/loki/.claude/.credentials.json"
# Dashboard port (kept identical to the local default).
: "${LOKI_DASHBOARD_PORT:=57374}"

# Detect which auth method is available on this host.
# Echoes one of: apikey | oauth | none
loki_docker_detect_auth() {
    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
        echo "apikey"
        return 0
    fi
    # macOS: token in the login keychain under "Claude Code-credentials".
    if command -v security >/dev/null 2>&1; then
        if security find-generic-password -s "Claude Code-credentials" -w >/dev/null 2>&1; then
            echo "oauth"
            return 0
        fi
    fi
    # Linux / non-keychain: claude stores creds as a plain file.
    if [ -f "${HOME}/.claude/.credentials.json" ]; then
        echo "oauth"
        return 0
    fi
    echo "none"
    return 0
}

# Extract host Claude Code OAuth credentials into $1 (0600). Returns non-zero
# if no host login is found. Writes ONLY the claudeAiOauth object claude needs;
# never the unrelated mcpOAuth blobs.
loki_docker_extract_creds() {
    local dest="$1"
    [ -n "$dest" ] || { echo "loki_docker_extract_creds: missing dest" >&2; return 2; }

    # Create the file privately BEFORE writing the token (no race on perms).
    ( umask 077; : > "$dest" ) || return 2
    chmod 600 "$dest" 2>/dev/null || true

    local raw=""
    if command -v security >/dev/null 2>&1; then
        raw="$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)"
    fi
    if [ -z "$raw" ] && [ -f "${HOME}/.claude/.credentials.json" ]; then
        raw="$(cat "${HOME}/.claude/.credentials.json" 2>/dev/null || true)"
    fi
    if [ -z "$raw" ]; then
        echo "loki_docker_extract_creds: no host Claude Code login found" >&2
        return 1
    fi

    # Normalize to {"claudeAiOauth": {...}}. Prefer jq; fall back to raw if jq
    # is absent and the payload already looks like the right shape.
    if command -v jq >/dev/null 2>&1; then
        if ! printf '%s' "$raw" | jq -e 'has("claudeAiOauth")' >/dev/null 2>&1; then
            echo "loki_docker_extract_creds: host credentials missing claudeAiOauth" >&2
            return 1
        fi
        printf '%s' "$raw" | jq '{claudeAiOauth}' > "$dest" 2>/dev/null || return 2
    else
        printf '%s' "$raw" > "$dest"
    fi
    chmod 600 "$dest" 2>/dev/null || true
    return 0
}

# Assemble the docker argv (printed one arg per line so callers can read it
# into an array safely). $1 = auth method (apikey|oauth|none), $2 = creds path
# (for oauth), remaining args = the loki command to run in the container.
# $1 = auth, $2 = creds path, $3 = with_api (1 to publish the dashboard port +
# enable the dashboard, like local `loki start --api`; 0 for a plain one-shot
# build). Remaining args = the loki command.
loki_docker_build_argv() {
    local auth="$1"; shift
    local creds="$1"; shift
    local with_api="${1:-0}"; shift
    local workspace; workspace="$(pwd)"

    local -a argv=(docker run --rm)
    # Allocate a TTY / keep stdin open ONLY when we actually have a terminal.
    # `-it` against a non-terminal (piped, CI, headless) fails with
    # "cannot attach stdin to a TTY-enabled container because stdin is not a
    # terminal". Probe stdin (-t 0) and stdout (-t 1) and add the flags
    # conditionally so the wrapper works both interactively and headless.
    # Override with LOKI_DOCKER_TTY=1 (force) or =0 (never).
    local _tty="${LOKI_DOCKER_TTY:-auto}"
    if [ "$_tty" = "1" ]; then
        argv+=(-it)
    elif [ "$_tty" = "auto" ] && [ -t 0 ] && [ -t 1 ]; then
        argv+=(-it)
    elif [ "$_tty" = "auto" ] && [ -t 0 ]; then
        argv+=(-i)
    fi
    # Workspace mount: this is what makes .loki state (and thus resume +
    # continuity) persist exactly like the local CLI.
    argv+=(-v "${workspace}:/workspace:rw" -w /workspace)
    # Dashboard: OFF by default, exactly like local `loki start` (which only
    # starts the dashboard with --api). A plain one-shot build does not need it,
    # and publishing a fixed host port made two `loki docker` runs collide on
    # 57374 and left a lingering container holding the port. With --api we both
    # enable the dashboard inside the container AND publish the port.
    if [ "$with_api" = "1" ]; then
        argv+=(-p "${LOKI_DASHBOARD_PORT}:${LOKI_DASHBOARD_PORT}")
        argv+=(-e "LOKI_DASHBOARD=true" -e "LOKI_DASHBOARD_PORT=${LOKI_DASHBOARD_PORT}")
    else
        argv+=(-e "LOKI_DASHBOARD=false")
    fi
    # Forward git/gh identity so commits + PRs work like local. Mounting just
    # ~/.gitconfig is NOT enough: it commonly uses `includeIf` to pull the real
    # identity from per-host files (e.g. a github.com identity in a separate
    # included file). Those includes are absent in the container, so git would
    # silently fall back to the top-level [user] -- which can be a corporate
    # default -- and mis-attribute commits. A `loki docker` build is destined for
    # github.com, so the container must commit with the GitHub identity. We
    # resolve it by preference:
    #   1. the identity from the user's github includeIf target (the file pulled
    #      in for github.com remotes), if we can find it -- this is the correct
    #      identity for the autonomous greenfield flow (build -> add github
    #      remote -> commit -> push), which a workspace-context lookup would miss
    #      because a fresh repo has no github remote yet;
    #   2. else the host's globally-configured identity.
    # Forwarded as authoritative GIT_AUTHOR_*/GIT_COMMITTER_* env. NOTE: this
    # freezes the identity for the run (env overrides per-commit includeIf
    # re-evaluation), which is the intended behavior here -- the container has
    # ONE purpose (github.com builds) so one frozen GitHub identity is correct.
    [ -f "${HOME}/.gitconfig" ] && argv+=(-v "${HOME}/.gitconfig:/home/loki/.gitconfig:ro")
    if command -v git >/dev/null 2>&1; then
        local _gname="" _gemail="" _ghinc=""
        # Find the path referenced by a github includeIf, if any.
        if [ -f "${HOME}/.gitconfig" ]; then
            _ghinc="$(git config --file "${HOME}/.gitconfig" --get-regexp 'includeif\..*github.*\.path' 2>/dev/null | awk '{print $2; exit}')"
            # Expand a leading ~ to $HOME. (The "~/" here is a literal case
            # pattern we are matching against, not a path to expand.)
            # shellcheck disable=SC2088
            case "$_ghinc" in "~/"*) _ghinc="${HOME}/${_ghinc#\~/}";; esac
        fi
        if [ -n "$_ghinc" ] && [ -f "$_ghinc" ]; then
            _gname="$(git config --file "$_ghinc" --get user.name 2>/dev/null || true)"
            _gemail="$(git config --file "$_ghinc" --get user.email 2>/dev/null || true)"
        fi
        # Fallback to the globally-resolved identity if the github include did
        # not yield one.
        [ -z "$_gname" ] && _gname="$(git config --get user.name 2>/dev/null || true)"
        [ -z "$_gemail" ] && _gemail="$(git config --get user.email 2>/dev/null || true)"
        if [ -n "$_gname" ]; then
            argv+=(-e "GIT_AUTHOR_NAME=${_gname}" -e "GIT_COMMITTER_NAME=${_gname}")
        fi
        if [ -n "$_gemail" ]; then
            argv+=(-e "GIT_AUTHOR_EMAIL=${_gemail}" -e "GIT_COMMITTER_EMAIL=${_gemail}")
        fi
    fi
    [ -d "${HOME}/.config/gh" ] && argv+=(-v "${HOME}/.config/gh:/home/loki/.config/gh:ro")
    # Forward GitHub tokens if set.
    [ -n "${GITHUB_TOKEN:-}" ] && argv+=(-e "GITHUB_TOKEN=${GITHUB_TOKEN}")
    [ -n "${GH_TOKEN:-}" ] && argv+=(-e "GH_TOKEN=${GH_TOKEN}")
    # No desktop notifications inside a container.
    argv+=(-e "LOKI_NOTIFICATIONS=false")
    # Multi-repo unified dashboard (Option B): the in-container run.sh must NOT
    # register into the project registry. A container only sees /workspace, not
    # the real host path, and registry.register_project() hard-fails on a path
    # that does not exist inside the container -- so in-container registration
    # is both wrong (every repo would key as /workspace) and a silent no-op.
    # Instead cmd_docker registers on the HOST with the real $(pwd), no pid, so
    # the existing host dashboard aggregates every `loki docker` repo exactly
    # like it aggregates host `loki start` repos (state read from the
    # bind-mounted .loki/session.json). See loki_register_running_project.
    argv+=(-e "LOKI_SKIP_PROJECT_REGISTRY=1")
    # Deterministic per-host-path container name: two repos get two distinct
    # concurrent containers (multi-repo parity with the host CLI) and a stable
    # handle for `loki docker stop`. Hash the workspace path; fall back to a
    # sanitized basename if no sha tool is present.
    local _name_hash=""
    if command -v shasum >/dev/null 2>&1; then
        _name_hash="$(printf '%s' "$workspace" | shasum -a 256 2>/dev/null | cut -c1-12)"
    elif command -v sha256sum >/dev/null 2>&1; then
        _name_hash="$(printf '%s' "$workspace" | sha256sum 2>/dev/null | cut -c1-12)"
    fi
    if [ -n "$_name_hash" ]; then
        argv+=(--name "loki-${_name_hash}")
    else
        argv+=(--name "loki-$(basename "$workspace" | tr -c 'A-Za-z0-9_.-' '_')")
    fi
    # The container IS the session boundary, so the runner must NOT setsid into
    # a new, detached session: setsid detach inside a `--rm` container makes the
    # `docker run` exit code report 0 even when the runner failed (a user with
    # an expired token would get RC=0 and a silently empty folder). Running the
    # runner in the foreground propagates the real exit code out through
    # `docker run`, so the wrapper exits non-zero on a failed build -- exactly
    # like the local CLI. Stop semantics still work: `docker stop` / Ctrl+C
    # signals the container's main process.
    argv+=(-e "LOKI_NO_NEW_SESSION=1")

    case "$auth" in
        apikey)
            argv+=(-e "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}")
            ;;
        oauth)
            # rw so the in-container claude can refresh the short-lived token
            # for the duration of THIS run. (The mounted file is a per-run temp
            # copy that is wiped on exit, so the refresh does not persist to the
            # host store -- but each run re-extracts a fresh, host-refreshed
            # token, so an idle token is never a problem.)
            argv+=(-v "${creds}:${_LOKI_DOCKER_CRED_DEST}:rw")
            ;;
    esac

    argv+=("$LOKI_DOCKER_IMAGE")
    argv+=("$@")

    printf '%s\n' "${argv[@]}"
}
