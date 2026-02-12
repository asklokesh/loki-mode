#!/bin/bash
# shellcheck disable=SC2034  # Unused variables are for future use or exported
# shellcheck disable=SC2155  # Declare and assign separately
#===============================================================================
# Loki Mode - API Server Launcher
#
# Usage:
#   ./autonomy/serve.sh [OPTIONS]
#   loki serve [OPTIONS]
#
# Options:
#   --port, -p <port>   Port to listen on (default: 57374)
#   --host, -h <host>   Host to bind to (default: localhost)
#   --no-cors           Disable CORS
#   --no-auth           Disable authentication
#   --help              Show help message
#
# Environment Variables:
#   LOKI_DASHBOARD_PORT Port (default: 57374)
#   LOKI_DASHBOARD_HOST Host (default: localhost)
#   LOKI_API_TOKEN      API token for remote access
#===============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$PROJECT_DIR/api"

# Default configuration
PORT="${LOKI_DASHBOARD_PORT:-57374}"
HOST="${LOKI_DASHBOARD_HOST:-localhost}"
CORS="true"
AUTH="true"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

log_info() {
    echo -e "${CYAN}[INFO]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

show_help() {
    cat << EOF
Loki Mode API Server

Usage:
  ./autonomy/serve.sh [OPTIONS]
  loki serve [OPTIONS]

Options:
  --port, -p <port>   Port to listen on (default: 57374)
  --host <host>       Host to bind to (default: localhost)
  --no-cors           Disable CORS
  --no-auth           Disable authentication
  --generate-token    Generate a new API token
  --help              Show this help message

Environment Variables:
  LOKI_DASHBOARD_PORT Port (overridden by --port)
  LOKI_DASHBOARD_HOST Host (overridden by --host)
  LOKI_API_TOKEN      API token for remote access
  LOKI_DIR            Loki installation directory
  LOKI_DEBUG          Enable debug output

Examples:
  # Start with defaults (localhost:57374)
  loki serve

  # Custom port
  loki serve --port 9000

  # Allow remote access (requires token)
  export LOKI_API_TOKEN=\$(loki serve --generate-token)
  loki serve --host 0.0.0.0

  # Connect from another machine
  curl -H "Authorization: Bearer \$TOKEN" http://server:57374/health

EOF
}

generate_token() {
    # Generate a secure random token
    if command -v openssl &> /dev/null; then
        openssl rand -hex 32
    elif command -v python3 &> /dev/null; then
        python3 -c "import secrets; print(secrets.token_hex(32))"
    else
        # Fallback to /dev/urandom
        head -c 32 /dev/urandom | xxd -p -c 64
    fi
}

check_deno() {
    if ! command -v deno &> /dev/null; then
        log_error "Deno is required but not installed."
        echo ""
        echo "Install Deno:"
        echo "  curl -fsSL https://deno.land/install.sh | sh"
        echo "  # or"
        echo "  brew install deno"
        echo ""
        exit 1
    fi
}

main() {
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --port|-p)
                PORT="$2"
                shift 2
                ;;
            --host)
                HOST="$2"
                shift 2
                ;;
            --no-cors)
                CORS="false"
                shift
                ;;
            --no-auth)
                AUTH="false"
                shift
                ;;
            --generate-token)
                generate_token
                exit 0
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done

    # Check for Deno
    check_deno

    # Check API directory exists
    if [ ! -f "$API_DIR/server.ts" ]; then
        log_error "API server not found at: $API_DIR/server.ts"
        exit 1
    fi

    # Display startup info
    echo ""
    echo -e "${BOLD}${BLUE}"
    echo "  ██╗      ██████╗ ██╗  ██╗██╗     █████╗ ██████╗ ██╗"
    echo "  ██║     ██╔═══██╗██║ ██╔╝██║    ██╔══██╗██╔══██╗██║"
    echo "  ██║     ██║   ██║█████╔╝ ██║    ███████║██████╔╝██║"
    echo "  ██║     ██║   ██║██╔═██╗ ██║    ██╔══██║██╔═══╝ ██║"
    echo "  ███████╗╚██████╔╝██║  ██╗██║    ██║  ██║██║     ██║"
    echo "  ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝    ╚═╝  ╚═╝╚═╝     ╚═╝"
    echo -e "${NC}"
    echo -e "  ${CYAN}HTTP/SSE API Server${NC}"
    echo -e "  ${CYAN}Version: $(cat "$PROJECT_DIR/VERSION" 2>/dev/null || echo "dev")${NC}"
    echo ""

    # Build command arguments
    local deno_args=(
        "--allow-net"
        "--allow-read"
        "--allow-write"
        "--allow-env"
        "--allow-run"
    )

    local server_args=(
        "--port" "$PORT"
        "--host" "$HOST"
    )

    [ "$CORS" = "false" ] && server_args+=("--no-cors")
    [ "$AUTH" = "false" ] && server_args+=("--no-auth")

    # Export environment variables
    export LOKI_DIR="$PROJECT_DIR"
    export LOKI_VERSION="$(cat "$PROJECT_DIR/VERSION" 2>/dev/null || echo "dev")"

    # Start the server
    log_info "Starting API server..."
    log_info "Deno version: $(deno --version | head -1)"
    echo ""

    exec deno run "${deno_args[@]}" "$API_DIR/server.ts" "${server_args[@]}"
}

main "$@"
