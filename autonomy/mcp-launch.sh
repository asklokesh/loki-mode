#!/usr/bin/env bash
# mcp-launch.sh -- launch the Loki Mode MCP server, bootstrapping its Python
# dependencies on first run (task 562).
#
# Why this exists: a fresh `npm install -g loki-mode` ships mcp/server.py and
# mcp/requirements.txt but installs NO Python packages and exposes only the
# `loki` bin. So `python3 -m mcp.server` exits because the MCP SDK is absent.
# `loki mcp` closes that gap: it checks for python3 + the MCP SDK, and when the
# SDK is missing it offers a consent-gated bootstrap into a project-local
# virtualenv (.loki/mcp-venv), then execs the server over stdio using THAT
# venv's python so the SDK is actually importable.
#
# Design (least-invasive, honest):
#   * Venv location: <project>/.loki/mcp-venv. Project-local, no global
#     site-packages pollution, no sudo, no curl-pipe-bash. Removing .loki
#     fully uninstalls. Override with LOKI_MCP_VENV=/abs/path.
#   * The ONLY command run on the user's behalf is, after explicit consent:
#       <venv>/bin/pip install -r mcp/requirements.txt
#     The exact command is printed before it runs.
#   * Non-interactive / CI: NEVER install. Print the manual command to stderr
#     and exit 2 (mirrors autonomy/provider-offer.sh gate semantics).
#   * Opt-out: LOKI_NO_INSTALL_OFFER=1 -> never prompt, print manual command,
#     exit 2. --yes / LOKI_ASSUME_YES / LOKI_AUTO_CONFIRM=true -> auto-accept.
#
# Self-containment: depends only on bash builtins + python3 on PATH. Defines
# its own colors so it behaves identically whether sourced by autonomy/loki or
# run standalone.

# Guard against double-source.
if [ -n "${_LOKI_MCP_LAUNCH_SOURCED:-}" ]; then
    return 0 2>/dev/null || true
fi
_LOKI_MCP_LAUNCH_SOURCED=1

# --- Self-contained colors (honor NO_COLOR) --------------------------------
if [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ]; then
    _ML_RED=''; _ML_YELLOW=''; _ML_BOLD=''; _ML_NC=''
else
    _ML_RED=$'\033[0;31m'
    _ML_YELLOW=$'\033[1;33m'
    _ML_BOLD=$'\033[1m'
    _ML_NC=$'\033[0m'
fi

# Repo root = parent of the directory holding this script (autonomy/..).
_ml_repo_root() {
    local self_dir
    self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    (cd "$self_dir/.." && pwd)
}

# _ml_assume_yes: true when the user opted into unattended confirmation.
_ml_assume_yes() {
    [ "${LOKI_ASSUME_YES:-}" = "1" ] && return 0
    [ "${LOKI_AUTO_CONFIRM:-}" = "true" ] && return 0
    return 1
}

# _ml_non_interactive: true when we must NEVER prompt (non-TTY or CI).
_ml_non_interactive() {
    [ ! -t 0 ] && return 0
    [ ! -t 1 ] && return 0
    [ -n "${CI:-}" ] && return 0
    return 1
}

# _ml_python: echo the best base python3 for creating the venv, or empty.
_ml_python() {
    local p
    for p in python3 python3.12 python3.11; do
        if command -v "$p" >/dev/null 2>&1; then
            printf '%s' "$p"
            return 0
        fi
    done
    return 1
}

# _ml_sdk_importable <python> <root>: true (0) only if the real MCP SDK's
# FastMCP can actually be CONSTRUCTED -- not merely that the SDK files exist on
# disk. A file-exists check is a false positive: under the local-vs-SDK `mcp`
# namespace collision the package-dir FastMCP can be present yet fail to import
# (`No module named 'mcp.types'`). We delegate to mcp/server.py's own
# `--check-sdk` probe, which runs the exact loader the server uses and exits 0
# only when FastMCP loaded. We run it with the repo root as cwd so the
# shadowing condition is exercised exactly as it will be at launch.
_ml_sdk_importable() {
    local py="$1" root="$2"
    ( cd "$root" && "$py" -m mcp.server --check-sdk >/dev/null 2>&1 )
}

_ml_print_manual() {
    local root="$1"
    printf 'Install the MCP server dependencies manually:\n' >&2
    printf '  python3 -m venv %s/.loki/mcp-venv\n' "$root" >&2
    printf '  %s/.loki/mcp-venv/bin/pip install -r %s/mcp/requirements.txt\n' "$root" "$root" >&2
    printf '  %s/.loki/mcp-venv/bin/python -m mcp.server\n' "$root" >&2
}

_ml_help() {
    cat <<'EOF'
Loki Mode -- launch the MCP (Model Context Protocol) server

Usage: loki mcp [--transport stdio|http] [--port N] [--help]

Starts the Loki Mode MCP server so MCP-aware clients (Claude Code, IDEs)
can call Loki's tools (memory, task queue, code search, build management).

On first run, if the Python MCP SDK is not installed, Loki offers to create
a project-local virtualenv at .loki/mcp-venv and install mcp/requirements.txt
into it (with your consent). The exact pip command is printed before it runs.
It then launches the server using that venv's python.

Options:
  --transport stdio|http  Transport to use (default: stdio).
  --port N                Port for http transport (default: 8421).
  --help, -h              Show this help and exit.

Environment:
  LOKI_MCP_VENV=/abs/path   Use a custom venv location instead of .loki/mcp-venv.
  LOKI_NO_INSTALL_OFFER=1   Never prompt to install; print the manual command.
  --yes / LOKI_ASSUME_YES=1 Auto-accept the dependency install.

Behavior in non-interactive / CI shells: never installs. Prints the manual
install command to stderr and exits 2.
EOF
}

# mcp_launch_main: dispatcher invoked by cmd_mcp() (autonomy/loki) or directly.
mcp_launch_main() {
    # Parse only flags we own; everything else is forwarded to the server.
    local arg
    for arg in "$@"; do
        case "$arg" in
            --help|-h|help)
                _ml_help
                return 0
                ;;
        esac
    done

    local root
    root="$(_ml_repo_root)"

    # 1. python3 presence.
    local base_py
    if ! base_py="$(_ml_python)"; then
        printf '%sNo python3 found on PATH.%s The MCP server needs Python 3.\n' "$_ML_RED" "$_ML_NC" >&2
        printf 'Install Python 3 (https://www.python.org/downloads), then re-run: loki mcp\n' >&2
        return 2
    fi

    # 2. venv location.
    local venv="${LOKI_MCP_VENV:-$root/.loki/mcp-venv}"
    local venv_py="$venv/bin/python"

    # 3. If the venv already has the SDK, use it directly.
    if [ -x "$venv_py" ] && _ml_sdk_importable "$venv_py" "$root"; then
        exec "$venv_py" -m mcp.server "$@"
    fi

    # 4. If the BASE python already has the SDK (e.g. user pip-installed it),
    #    use it -- no venv needed.
    if _ml_sdk_importable "$base_py" "$root"; then
        exec "$base_py" -m mcp.server "$@"
    fi

    # 5. SDK missing. Decide whether we may bootstrap.
    if [ "${LOKI_NO_INSTALL_OFFER:-}" = "1" ]; then
        printf '%sMCP SDK not installed.%s\n' "$_ML_YELLOW" "$_ML_NC" >&2
        _ml_print_manual "$root"
        return 2
    fi

    if _ml_non_interactive; then
        printf '%sMCP SDK not installed%s and this is a non-interactive shell, so Loki will not install it automatically.\n' "$_ML_YELLOW" "$_ML_NC" >&2
        _ml_print_manual "$root"
        return 2
    fi

    # 6. Interactive TTY: offer the consent-gated bootstrap.
    local answer=""
    if _ml_assume_yes; then
        answer="y"
    else
        printf '\n'
        printf 'The MCP server needs Python dependencies that are not installed.\n'
        printf 'Loki can create a project-local virtualenv and install them:\n'
        printf '  python3 -m venv %s\n' "$venv"
        printf '  %s/bin/pip install -r %s/mcp/requirements.txt\n' "$venv" "$root"
        printf '\n'
        printf 'Nothing is installed globally and no sudo is used. Proceed? [Y/n] '
        read -r answer || answer="n"
    fi

    case "$answer" in
        ""|y|Y|yes|YES) ;;
        *)
            printf 'Skipped.\n'
            _ml_print_manual "$root"
            return 2
            ;;
    esac

    # 7. Create the venv if needed.
    if [ ! -x "$venv_py" ]; then
        printf 'Creating virtualenv (%s) ...\n' "$venv"
        if ! "$base_py" -m venv "$venv"; then
            printf '%sFailed to create virtualenv at %s.%s\n' "$_ML_RED" "$venv" "$_ML_NC" >&2
            _ml_print_manual "$root"
            return 2
        fi
    fi

    # 8. Install requirements into the venv.
    local req="$root/mcp/requirements.txt"
    if [ ! -f "$req" ]; then
        printf '%smcp/requirements.txt not found at %s.%s\n' "$_ML_RED" "$req" "$_ML_NC" >&2
        return 2
    fi
    printf 'Installing MCP dependencies (%s/bin/pip install -r %s) ...\n' "$venv" "$req"
    local code=0
    "$venv/bin/pip" install -r "$req" || code=$?
    if [ "$code" -ne 0 ]; then
        printf '%sInstall failed (pip exited %s).%s You can retry manually:\n' "$_ML_RED" "$code" "$_ML_NC" >&2
        _ml_print_manual "$root"
        return 2
    fi

    # 9. Verify, then exec the server using the venv python (critical: the
    #    site-packages walk in server.py only finds the SDK if we run the
    #    venv's interpreter, not the ambient python3).
    if ! _ml_sdk_importable "$venv_py" "$root"; then
        printf '%sDependencies installed but the MCP SDK still is not importable.%s\n' "$_ML_RED" "$_ML_NC" >&2
        _ml_print_manual "$root"
        return 2
    fi
    printf "%sMCP dependencies ready. Launching server over stdio ...%s\n" "$_ML_BOLD" "$_ML_NC" >&2
    exec "$venv_py" -m mcp.server "$@"
}

# Executed directly (tests, manual): run the dispatcher.
# When sourced by autonomy/loki, this block does not run.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    mcp_launch_main "$@"
fi
