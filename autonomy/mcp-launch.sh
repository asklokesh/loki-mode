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
#   * Venv location: <user-cwd>/.loki/mcp-venv (the project Loki is invoked in,
#     NOT the install root). Project-local, no global site-packages pollution,
#     no sudo, no curl-pipe-bash, no root-owned writes under a global install.
#     Removing the project's .loki fully uninstalls. Override with
#     LOKI_MCP_VENV=/abs/path. Honors LOKI_DIR (defaults to .loki).
#   * The server is launched with PYTHONPATH set to the install root (NOT by
#     cd-ing into it) so the user's cwd is preserved: mcp/server.py resolves the
#     project .loki from os.getcwd(). Without PYTHONPATH, `import mcp` from an
#     arbitrary cwd resolves to the pip MCP SDK's own `mcp` package (zero Loki
#     tools); PYTHONPATH puts the install root first so the LOCAL mcp/server.py
#     wins, while server.py's namespace juggle still hands the real SDK its own
#     `mcp.*` subtree.
#   * The ONLY command run on the user's behalf is, after explicit consent:
#       <venv>/bin/pip install -r mcp/requirements.txt
#     The exact command is printed before it runs.
#   * Non-interactive / CI: NEVER install by default. Print the manual command
#     to stderr and exit 2 (mirrors autonomy/provider-offer.sh gate semantics).
#     EXCEPTION: LOKI_MCP_AUTO_BOOTSTRAP (1/true/yes/on, case-insensitive) is
#     explicit-env written consent. MCP
#     clients (Claude Desktop etc.) spawn the server non-interactively over piped
#     stdio; a user who writes LOKI_MCP_AUTO_BOOTSTRAP=1 into their client config
#     has consented in advance. On that flag, a missing-SDK non-TTY launch
#     bootstraps the venv exactly like the interactive consent path, but with ALL
#     progress on STDERR (stdout stays clean for JSON-RPC: the client is already
#     attached to it), then execs the server. LOKI_NO_INSTALL_OFFER=1 still wins
#     (explicit no beats explicit yes).
#   * Opt-out: LOKI_NO_INSTALL_OFFER=1 -> never prompt, print manual command,
#     exit 2. --yes / LOKI_ASSUME_YES / LOKI_AUTO_CONFIRM=true -> auto-accept.
#     LOKI_MCP_AUTO_BOOTSTRAP=1 -> non-interactive written consent (see above).
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

# _ml_truthy <value>: true (0) when the value is a conventional affirmative
# spelling (1/true/yes/on/y), case-insensitive. Centralizes consent parsing so
# every knob accepts the same spellings rather than each hard-coding "1".
_ml_truthy() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on|y) return 0 ;;
        *) return 1 ;;
    esac
}

# _ml_assume_yes: true when the user opted into unattended confirmation.
_ml_assume_yes() {
    _ml_truthy "${LOKI_ASSUME_YES:-}" && return 0
    _ml_truthy "${LOKI_AUTO_CONFIRM:-}" && return 0
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
# only when FastMCP loaded.
#
# Critical: we set PYTHONPATH to the install root and DO NOT cd into it, so the
# probe exercises the SAME module resolution as the real launch (which preserves
# the user's cwd). The redirect of stdin from /dev/null is insurance: if the
# pip SDK's own `mcp.server` were ever reached, its stub starts a stdio receive
# loop; the EOF makes it exit instead of hanging.
_ml_sdk_importable() {
    local py="$1" root="$2"
    PYTHONPATH="$root${PYTHONPATH:+:$PYTHONPATH}" \
        "$py" -m mcp.server --check-sdk </dev/null >/dev/null 2>&1
}

# _ml_print_manual <root> <venv>: print the honest manual install commands.
# The venv lives in the user's project (.loki/mcp-venv by default), while
# requirements.txt is shipped under the install root.
_ml_print_manual() {
    local root="$1" venv="$2"
    # Display-only quoting: single-quote the substituted paths so the printed
    # commands copy-paste correctly even when the project root or venv path
    # contains spaces. This is presentation only; nothing is executed here.
    printf 'Install the MCP server dependencies manually:\n' >&2
    printf "  python3 -m venv '%s'\n" "$venv" >&2
    printf "  '%s/bin/pip' install -r '%s/mcp/requirements.txt'\n" "$venv" "$root" >&2
    printf "  PYTHONPATH='%s' '%s/bin/python' -m mcp.server\n" "$root" "$venv" >&2
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
  LOKI_MCP_VENV=/abs/path     Use a custom venv location instead of .loki/mcp-venv.
  LOKI_NO_INSTALL_OFFER=1     Never prompt to install; print the manual command.
                              Wins over LOKI_MCP_AUTO_BOOTSTRAP (explicit no beats
                              explicit yes).
  LOKI_MCP_AUTO_BOOTSTRAP=1   Written consent for non-interactive bootstrap. MCP
                              clients (Claude Desktop etc.) spawn the server over
                              piped stdio with no TTY; set this in your client
                              config to authorize the one-time venv bootstrap when
                              the SDK is missing. Progress goes to stderr only so
                              stdout stays clean for JSON-RPC. On a TTY it also
                              skips the consent prompt (consent already given).
                              Accepts 1/true/yes/on (case-insensitive).
  --yes / LOKI_ASSUME_YES=1   Auto-accept the dependency install. --yes is a
                              launcher flag (equivalent to LOKI_ASSUME_YES=1); it
                              is consumed here and never forwarded to the server.
                              LOKI_ASSUME_YES / LOKI_AUTO_CONFIRM accept
                              1/true/yes/on (case-insensitive).

Argument handling: launcher flags (--help, --yes) are consumed here; every other
argument is forwarded verbatim to the server, which accepts --transport/--port.
A bare `--` ends launcher parsing so anything after it reaches the server as-is.

Behavior in non-interactive / CI shells: never installs UNLESS
LOKI_MCP_AUTO_BOOTSTRAP is set (1/true/yes/on). Without it, prints the manual
install command to stderr and exits 2.
EOF
}

# mcp_launch_main: dispatcher invoked by cmd_mcp() (autonomy/loki) or directly.
mcp_launch_main() {
    # Split argv into launcher-owned flags (consumed here) and server argv
    # (forwarded verbatim to `python -m mcp.server`). The server's argparse only
    # accepts --transport/--port/--check-sdk; forwarding a launcher flag like
    # --yes would make it abort with exit 2, so launcher flags MUST be stripped.
    # A bare `--` ends launcher parsing: everything after it is forwarded as-is
    # (escape hatch for any future server flag that collides with a launcher one).
    local arg
    local _ml_server_argv=()
    local _ml_after_sep=0
    for arg in "$@"; do
        if [ "$_ml_after_sep" -eq 1 ]; then
            _ml_server_argv+=("$arg")
            continue
        fi
        case "$arg" in
            --)
                _ml_after_sep=1
                ;;
            --help|-h|help)
                _ml_help
                return 0
                ;;
            --yes)
                # Launcher-owned: equivalent to LOKI_ASSUME_YES=1. Consumed here,
                # never forwarded to the server.
                LOKI_ASSUME_YES=1
                ;;
            *)
                _ml_server_argv+=("$arg")
                ;;
        esac
    done
    # Replace the positional parameters with the filtered server argv so every
    # downstream `exec ... "$@"` forwards only server-valid arguments. Safe
    # empty-array expansion (bash 3.2 + set -u when no server args remain).
    set -- ${_ml_server_argv[@]+"${_ml_server_argv[@]}"}

    local root
    root="$(_ml_repo_root)"

    # 1. python3 presence.
    local base_py
    if ! base_py="$(_ml_python)"; then
        printf '%sNo python3 found on PATH.%s The MCP server needs Python 3.\n' "$_ML_RED" "$_ML_NC" >&2
        printf 'Install Python 3 (https://www.python.org/downloads), then re-run: loki mcp\n' >&2
        return 2
    fi

    # 2. venv location. Lives in the USER'S project (their cwd), NOT the install
    #    root: $root may be a root-owned global npm prefix where we must never
    #    write. LOKI_DIR (default .loki) keeps this consistent with every other
    #    .loki artifact; LOKI_MCP_VENV overrides outright.
    local venv="${LOKI_MCP_VENV:-$PWD/${LOKI_DIR:-.loki}/mcp-venv}"
    local venv_py="$venv/bin/python"

    # Progress destination for the bootstrap. On an interactive TTY, progress goes
    # to stdout (the user is watching a terminal). On the non-interactive
    # auto-bootstrap path (LOKI_MCP_AUTO_BOOTSTRAP=1 over piped stdio), stdout is
    # the JSON-RPC channel to the MCP client and MUST stay clean, so ALL progress
    # (printfs AND the stdout of venv/pip) is routed to fd 2. Keyed on
    # non-interactive, not on the flag: TTY+flag still prints to the terminal.
    local out_fd=1
    if _ml_non_interactive; then
        out_fd=2
    fi

    # 3. If the venv already has the SDK, use it directly. The server is launched
    #    with PYTHONPATH=$root (NOT by cd-ing) so the user's cwd is preserved for
    #    .loki resolution; see _ml_sdk_importable for why.
    #    Known narrow residual: if the user's cwd itself contains a Python
    #    package literally named mcp/ with a server submodule, python -m puts
    #    the cwd ahead of PYTHONPATH and that package wins. Essentially never
    #    true for real projects; documented rather than fought.
    if [ -x "$venv_py" ] && _ml_sdk_importable "$venv_py" "$root"; then
        exec env PYTHONPATH="$root${PYTHONPATH:+:$PYTHONPATH}" "$venv_py" -m mcp.server "$@"
    fi

    # 4. If the BASE python already has the SDK (e.g. user pip-installed it),
    #    use it -- no venv needed.
    if _ml_sdk_importable "$base_py" "$root"; then
        exec env PYTHONPATH="$root${PYTHONPATH:+:$PYTHONPATH}" "$base_py" -m mcp.server "$@"
    fi

    # 5. SDK missing. Decide whether we may bootstrap.
    #    Precedence: LOKI_NO_INSTALL_OFFER (explicit no) wins over
    #    LOKI_MCP_AUTO_BOOTSTRAP (explicit yes).
    if _ml_truthy "${LOKI_NO_INSTALL_OFFER:-}"; then
        if _ml_truthy "${LOKI_MCP_AUTO_BOOTSTRAP:-}"; then
            printf 'LOKI_NO_INSTALL_OFFER overrides LOKI_MCP_AUTO_BOOTSTRAP (explicit no beats explicit yes); not installing.\n' >&2
        fi
        printf '%sMCP SDK not installed.%s\n' "$_ML_YELLOW" "$_ML_NC" >&2
        _ml_print_manual "$root" "$venv"
        return 2
    fi

    # Track whether we reached the bootstrap via non-interactive written consent.
    # When true, the consent prompt is skipped and all progress goes to fd 2.
    local auto_consent=0
    if _ml_non_interactive; then
        if _ml_truthy "${LOKI_MCP_AUTO_BOOTSTRAP:-}"; then
            # Written consent: bootstrap non-interactively, progress to stderr
            # only (stdout is the client's JSON-RPC channel). Fall through to the
            # bootstrap below with auto-accept.
            printf '%sMCP SDK not installed.%s LOKI_MCP_AUTO_BOOTSTRAP set: bootstrapping the project venv non-interactively (progress on stderr; stdout reserved for JSON-RPC).\n' "$_ML_YELLOW" "$_ML_NC" >&2
            auto_consent=1
        else
            printf '%sMCP SDK not installed%s and this is a non-interactive shell, so Loki will not install it automatically. Set LOKI_MCP_AUTO_BOOTSTRAP=1 (also accepts true/yes) to authorize this for MCP clients.\n' "$_ML_YELLOW" "$_ML_NC" >&2
            _ml_print_manual "$root" "$venv"
            return 2
        fi
    fi

    # 6. Offer the consent-gated bootstrap. Consent is already given when:
    #    - we arrived via the non-interactive auto-bootstrap path (auto_consent), or
    #    - LOKI_MCP_AUTO_BOOTSTRAP=1 is set on a TTY (explicit yes skips the prompt), or
    #    - --yes / LOKI_ASSUME_YES / LOKI_AUTO_CONFIRM.
    local answer=""
    if [ "$auto_consent" -eq 1 ] || _ml_truthy "${LOKI_MCP_AUTO_BOOTSTRAP:-}" || _ml_assume_yes; then
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
            _ml_print_manual "$root" "$venv"
            return 2
            ;;
    esac

    # 7. Create the venv if needed. Ensure the parent .loki exists in the user's
    #    project first (never write under the install root).
    if [ ! -x "$venv_py" ]; then
        local venv_parent
        venv_parent="$(dirname "$venv")"
        if [ ! -d "$venv_parent" ] && ! mkdir -p "$venv_parent"; then
            printf '%sCannot create %s (no write access).%s\n' "$_ML_RED" "$venv_parent" "$_ML_NC" >&2
            _ml_print_manual "$root" "$venv"
            return 2
        fi
        printf 'Creating virtualenv (%s) ...\n' "$venv" >&"$out_fd"
        # Route venv's stdout to out_fd (stderr on the auto path) so the JSON-RPC
        # channel stays clean; its stderr is left as-is for real diagnostics.
        if ! "$base_py" -m venv "$venv" >&"$out_fd"; then
            printf '%sFailed to create virtualenv at %s.%s\n' "$_ML_RED" "$venv" "$_ML_NC" >&2
            _ml_print_manual "$root" "$venv"
            return 2
        fi
    fi

    # 8. Install requirements into the venv.
    local req="$root/mcp/requirements.txt"
    if [ ! -f "$req" ]; then
        printf '%smcp/requirements.txt not found at %s.%s\n' "$_ML_RED" "$req" "$_ML_NC" >&2
        return 2
    fi
    printf 'Installing MCP dependencies (%s/bin/pip install -r %s) ...\n' "$venv" "$req" >&"$out_fd"
    local code=0
    # pip writes its progress to stdout; route it to out_fd (stderr on the auto
    # path) so the JSON-RPC channel stays clean. pip's stderr is left as-is.
    "$venv/bin/pip" install -r "$req" >&"$out_fd" || code=$?
    if [ "$code" -ne 0 ]; then
        printf '%sInstall failed (pip exited %s).%s You can retry manually:\n' "$_ML_RED" "$code" "$_ML_NC" >&2
        _ml_print_manual "$root" "$venv"
        return 2
    fi

    # 9. Verify, then exec the server using the venv python (critical: the
    #    site-packages walk in server.py only finds the SDK if we run the
    #    venv's interpreter, not the ambient python3). PYTHONPATH=$root keeps the
    #    user's cwd intact for .loki resolution; see _ml_sdk_importable.
    if ! _ml_sdk_importable "$venv_py" "$root"; then
        printf '%sDependencies installed but the MCP SDK still is not importable.%s\n' "$_ML_RED" "$_ML_NC" >&2
        _ml_print_manual "$root" "$venv"
        return 2
    fi
    printf "%sMCP dependencies ready. Launching server over stdio ...%s\n" "$_ML_BOLD" "$_ML_NC" >&2
    exec env PYTHONPATH="$root${PYTHONPATH:+:$PYTHONPATH}" "$venv_py" -m mcp.server "$@"
}

# Executed directly (tests, manual): run the dispatcher.
# When sourced by autonomy/loki, this block does not run.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    mcp_launch_main "$@"
fi
