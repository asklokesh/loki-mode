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
    # The container runs as uid 1000 but a macOS Docker Desktop bind mount can
    # look root-owned, so the repo tool refuses /workspace ("dubious ownership").
    # Trust it via env config, appending after any caller-set GIT_CONFIG_COUNT=N.
    local _gc_n="${GIT_CONFIG_COUNT:-0}"
    case "$_gc_n" in ''|*[!0-9]*) _gc_n=0 ;; esac
    argv+=(-e "GIT_CONFIG_COUNT=$((_gc_n + 1))"
        -e "GIT_CONFIG_KEY_${_gc_n}=safe.directory"
        -e "GIT_CONFIG_VALUE_${_gc_n}=/workspace")
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
    # handle for `loki docker stop`. Computed by loki_docker_container_name
    # (single source of truth so cmd_stop reaps the exact same name): sha12 of
    # the workspace path, with a sanitized-basename fallback if no sha tool is
    # present.
    argv+=(--name "$(loki_docker_container_name "$workspace")")
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

#===============================================================================
# Wave-4 Docker helpers (FEAT-DOCKER-DASH / FEAT-DOCKER-PRUNE / FIX-DOCKER-STOP)
#
# These are called by autonomy/loki (cmd_docker, cmd_stop). The CLI guards each
# call with `declare -F <name>` so missing helpers degrade gracefully, but the
# NAMES below are part of the contract and must not change.
#
# Call contracts (Agent A call sites must match exactly):
#
#   loki_docker_pick_host_port
#     args: none
#     stdout: a single free host port number (nothing else)
#     port precedence: ${DASHBOARD_DEFAULT_PORT:-${LOKI_DASHBOARD_PORT:-57374}};
#       if that port is bound, increments to the next free port (up to 50 tries).
#
#   loki_docker_pull_and_prune
#     args: none (reads $LOKI_DOCKER_IMAGE, $LOKI_DOCKER_PRUNE)
#     gate: LOKI_DOCKER_PRUNE (default 1). When 0 -> returns 0 immediately,
#       no docker pull and no prune.
#     side effects: docker pull, then best-effort rmi of OLD/unused
#       asklokesh/loki-mode images only. Prints an honest summary.
#     return: always 0 (best-effort; partial rmi failure is non-fatal).
#
#   loki_docker_write_runstate <container> <image> [project_dir]
#     args: $1 container name, $2 image ref, $3 project dir (default $(pwd))
#     side effect: atomically writes <project_dir>/.loki/docker/run.json:
#       {"container","image","project_dir","started_at"(ISO8601 UTC)}
#     return: 0 on success, non-zero if the file could not be written.
#
#   loki_docker_clear_runstate [project_dir]
#     args: $1 project dir (default $(pwd))
#     side effect: rm -f <project_dir>/.loki/docker/run.json (no error if absent)
#     return: always 0.
#
#   loki_docker_container_name [workspace_path]
#     args: $1 workspace path (default $(pwd))
#     stdout: the deterministic container name loki-<sha12 of path>, identical
#       to the name loki_docker_build_argv assigns (basename fallback if no
#       sha tool is present). Nothing else on stdout.
#===============================================================================

# Normalize a docker image identifier for comparison: strip a leading "sha256:"
# and truncate to the 12-char short form. `docker images --format '{{.ID}}'`
# emits a short id, while `docker inspect --format '{{.Id}}'` and
# `docker ps --format '{{.ImageID}}'` emit the full "sha256:<64hex>" form, so
# the prune logic MUST normalize both sides before comparing -- otherwise the
# ":latest" / in-use exclusions silently fail and we delete the wrong image.
_loki_docker_norm_id() {
    local id="${1#sha256:}"
    printf '%s' "${id:0:12}"
}

# Probe seam: returns 0 if $1 (a host port) is FREE, non-zero if bound.
# Factored out so tests can override it without binding a real socket.
# Prefers lsof (used elsewhere in the repo), falls back to nc, then to a
# bash /dev/tcp probe so there is no hard lsof dependency.
_loki_docker_port_free() {
    local port="$1"
    if command -v lsof >/dev/null 2>&1; then
        ! lsof -i ":$port" >/dev/null 2>&1
    elif command -v nc >/dev/null 2>&1; then
        ! nc -z 127.0.0.1 "$port" >/dev/null 2>&1
    else
        # /dev/tcp connect: success means something is listening -> port busy.
        ! (exec 3<>"/dev/tcp/127.0.0.1/${port}") >/dev/null 2>&1
    fi
}

# Echo a free host port. Tries the default dashboard port first, then walks up.
loki_docker_pick_host_port() {
    local port="${DASHBOARD_DEFAULT_PORT:-${LOKI_DASHBOARD_PORT:-57374}}"
    local attempts=0
    while ! _loki_docker_port_free "$port" && [ "$attempts" -lt 50 ]; do
        port=$((port + 1))
        attempts=$((attempts + 1))
    done
    printf '%s\n' "$port"
}

# Pull the loki-mode image and prune ONLY old/unused asklokesh/loki-mode images.
# Triple-scoped safety: (1) reference filter limits enumeration to
# asklokesh/loki-mode, (2) the just-pulled :latest id is excluded, (3) any id
# in use by a running container is excluded. NEVER `docker image prune -a`.
loki_docker_pull_and_prune() {
    local image="${LOKI_DOCKER_IMAGE:-asklokesh/loki-mode:latest}"
    local prune="${LOKI_DOCKER_PRUNE:-1}"

    # Opt-out: skip the explicit pull AND the prune entirely.
    if [ "$prune" = "0" ]; then
        return 0
    fi

    if ! command -v docker >/dev/null 2>&1; then
        echo "loki_docker_pull_and_prune: docker not found; skipping" >&2
        return 0
    fi

    echo "Pulling ${image} ..."
    docker pull "$image" >/dev/null 2>&1 || {
        echo "loki_docker_pull_and_prune: pull failed; skipping prune" >&2
        return 0
    }

    # Capture the just-pulled image id (normalized short form). If inspect
    # yields nothing we cannot safely exclude the just-pulled image from the
    # rmi set, so bail rather than risk deleting it.
    local latest_raw latest_id
    latest_raw="$(docker inspect --format '{{.Id}}' "$image" 2>/dev/null)"
    if [ -z "$latest_raw" ]; then
        echo "loki_docker_pull_and_prune: could not resolve pulled image id; skipping prune" >&2
        return 0
    fi
    latest_id="$(_loki_docker_norm_id "$latest_raw")"

    # Build the in-use set from running containers (image ids AND names).
    # Normalize ids so a full sha256 id matches the short id from `docker images`.
    local -A in_use=()
    local _line _iid _iname
    while IFS=' ' read -r _iid _iname; do
        [ -n "$_iid" ] && in_use["$(_loki_docker_norm_id "$_iid")"]=1
        [ -n "$_iname" ] && in_use["$_iname"]=1
    done < <(docker ps --format '{{.ImageID}} {{.Image}}' 2>/dev/null)

    # Enumerate ONLY asklokesh/loki-mode images (tagged + dangling), scoped by
    # the reference filter so a non-loki-mode image is never even considered.
    local -A candidates=()
    while read -r _id; do
        [ -n "$_id" ] && candidates["$(_loki_docker_norm_id "$_id")"]=1
    done < <(docker images --filter 'reference=asklokesh/loki-mode' --format '{{.ID}}' 2>/dev/null)
    while read -r _id; do
        [ -n "$_id" ] && candidates["$(_loki_docker_norm_id "$_id")"]=1
    done < <(docker images --filter 'reference=asklokesh/loki-mode' --filter 'dangling=true' -q 2>/dev/null)

    # rmi each candidate that is NOT the just-pulled :latest AND NOT in use.
    local reclaimed=0 cand
    for cand in "${!candidates[@]}"; do
        if [ -n "$latest_id" ] && [ "$cand" = "$latest_id" ]; then
            continue
        fi
        if [ -n "${in_use[$cand]:-}" ]; then
            continue
        fi
        if docker rmi "$cand" >/dev/null 2>&1; then
            reclaimed=$((reclaimed + 1))
        fi
    done

    if [ "$reclaimed" -gt 0 ]; then
        echo "Reclaimed ${reclaimed} old loki-mode image(s)."
    else
        echo "Image cleanup: nothing to reclaim."
    fi
    return 0
}

# Write .loki/docker/run.json atomically. See contract block above for args.
loki_docker_write_runstate() {
    local container="$1"
    local image="$2"
    local project_dir="${3:-$(pwd)}"
    [ -n "$container" ] || { echo "loki_docker_write_runstate: missing container" >&2; return 2; }
    [ -n "$image" ] || { echo "loki_docker_write_runstate: missing image" >&2; return 2; }

    local dir="${project_dir}/.loki/docker"
    mkdir -p "$dir" || return 2

    local started_at
    started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"

    # tmp file in the SAME dir as the target so `mv` is an atomic rename, not a
    # cross-device copy.
    local tmp="${dir}/.run.json.$$"
    {
        printf '{\n'
        printf '  "container": "%s",\n' "$container"
        printf '  "image": "%s",\n' "$image"
        printf '  "project_dir": "%s",\n' "$project_dir"
        printf '  "started_at": "%s"\n' "$started_at"
        printf '}\n'
    } > "$tmp" || { rm -f "$tmp" 2>/dev/null; return 2; }

    mv -f "$tmp" "${dir}/run.json" || { rm -f "$tmp" 2>/dev/null; return 2; }
    return 0
}

# Remove .loki/docker/run.json. No error if it is already gone.
loki_docker_clear_runstate() {
    local project_dir="${1:-$(pwd)}"
    rm -f "${project_dir}/.loki/docker/run.json" 2>/dev/null
    return 0
}

# Echo the deterministic container name for a workspace path. This MUST stay
# byte-identical to the name loki_docker_build_argv assigns (lines ~204-214), so
# cmd_stop can reap the container by name. Same sha12 logic + basename fallback.
loki_docker_container_name() {
    local workspace="${1:-$(pwd)}"
    local _name_hash=""
    if command -v shasum >/dev/null 2>&1; then
        _name_hash="$(printf '%s' "$workspace" | shasum -a 256 2>/dev/null | cut -c1-12)"
    elif command -v sha256sum >/dev/null 2>&1; then
        _name_hash="$(printf '%s' "$workspace" | sha256sum 2>/dev/null | cut -c1-12)"
    fi
    if [ -n "$_name_hash" ]; then
        printf '%s\n' "loki-${_name_hash}"
    else
        printf '%s\n' "loki-$(basename "$workspace" | tr -c 'A-Za-z0-9_.-' '_')"
    fi
}
