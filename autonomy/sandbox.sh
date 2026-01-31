#!/bin/bash
#===============================================================================
# Loki Mode - Docker Sandbox Manager
# Provides isolated container execution for enhanced security
#
# Usage:
#   ./autonomy/sandbox.sh start [OPTIONS] [PRD_PATH]
#   ./autonomy/sandbox.sh stop
#   ./autonomy/sandbox.sh status
#   ./autonomy/sandbox.sh shell
#
# Environment Variables:
#   LOKI_SANDBOX_IMAGE    - Docker image to use (default: loki-mode:sandbox)
#   LOKI_SANDBOX_NETWORK  - Network mode: bridge, none, host (default: bridge)
#   LOKI_SANDBOX_CPUS     - CPU limit (default: 2)
#   LOKI_SANDBOX_MEMORY   - Memory limit (default: 4g)
#   LOKI_SANDBOX_READONLY - Mount project as read-only (default: false)
#
# Security Features:
#   - Seccomp profile restricts dangerous syscalls
#   - No new privileges flag prevents privilege escalation
#   - Dropped capabilities reduce attack surface
#   - Resource limits prevent DoS
#   - Optional read-only filesystem
#   - API keys mounted read-only
#===============================================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
BOLD='\033[1m'

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="${LOKI_PROJECT_DIR:-$(pwd)}"
CONTAINER_NAME="loki-sandbox-$(basename "$PROJECT_DIR" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')"

# Sandbox settings
SANDBOX_IMAGE="${LOKI_SANDBOX_IMAGE:-loki-mode:sandbox}"
SANDBOX_NETWORK="${LOKI_SANDBOX_NETWORK:-bridge}"
SANDBOX_CPUS="${LOKI_SANDBOX_CPUS:-2}"
SANDBOX_MEMORY="${LOKI_SANDBOX_MEMORY:-4g}"
SANDBOX_READONLY="${LOKI_SANDBOX_READONLY:-false}"

# API ports
API_PORT="${LOKI_API_PORT:-9898}"
DASHBOARD_PORT="${LOKI_DASHBOARD_PORT:-57374}"

#===============================================================================
# Utility Functions
#===============================================================================

log_info() {
    echo -e "${BLUE}[SANDBOX]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SANDBOX]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[SANDBOX]${NC} $1"
}

log_error() {
    echo -e "${RED}[SANDBOX]${NC} $1" >&2
}

check_docker() {
    if ! command -v docker &> /dev/null; then
        log_error "Docker not found. Install Docker to use sandbox mode."
        log_error "  macOS: brew install --cask docker"
        log_error "  Linux: curl -fsSL https://get.docker.com | sh"
        exit 1
    fi

    if ! docker info &> /dev/null; then
        log_error "Docker daemon not running. Start Docker Desktop or dockerd."
        exit 1
    fi
}

build_sandbox_image() {
    local dockerfile="$SKILL_DIR/Dockerfile.sandbox"

    if [[ ! -f "$dockerfile" ]]; then
        log_error "Sandbox Dockerfile not found at $dockerfile"
        exit 1
    fi

    log_info "Building sandbox image..."
    docker build -t "$SANDBOX_IMAGE" -f "$dockerfile" "$SKILL_DIR"
    log_success "Sandbox image built: $SANDBOX_IMAGE"
}

ensure_image() {
    if ! docker image inspect "$SANDBOX_IMAGE" &> /dev/null; then
        log_warn "Sandbox image not found. Building..."
        build_sandbox_image
    fi
}

#===============================================================================
# Container Management
#===============================================================================

start_sandbox() {
    local prd_path="${1:-}"
    local provider="${LOKI_PROVIDER:-claude}"

    check_docker
    ensure_image

    # Check if already running
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_warn "Sandbox already running: $CONTAINER_NAME"
        log_info "Use 'loki sandbox status' to check or 'loki sandbox stop' to stop"
        return 0
    fi

    # Clean up any stopped container with same name
    docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

    log_info "Starting sandbox container..."
    log_info "  Image:    $SANDBOX_IMAGE"
    log_info "  Project:  $PROJECT_DIR"
    log_info "  Provider: $provider"
    log_info "  Network:  $SANDBOX_NETWORK"
    log_info "  CPUs:     $SANDBOX_CPUS"
    log_info "  Memory:   $SANDBOX_MEMORY"

    # Build docker run command
    local docker_args=(
        "run"
        "--name" "$CONTAINER_NAME"
        "--detach"
        "--interactive"
        "--tty"

        # Resource limits
        "--cpus=$SANDBOX_CPUS"
        "--memory=$SANDBOX_MEMORY"
        "--memory-swap=$SANDBOX_MEMORY"  # Disable swap
        "--pids-limit=256"

        # Security hardening
        "--security-opt=no-new-privileges:true"
        "--cap-drop=ALL"
        "--cap-add=CHOWN"
        "--cap-add=SETUID"
        "--cap-add=SETGID"

        # Network
        "--network=$SANDBOX_NETWORK"
    )

    # Add seccomp profile if available
    local seccomp_profile="$SKILL_DIR/autonomy/seccomp-sandbox.json"
    if [[ -f "$seccomp_profile" ]]; then
        docker_args+=("--security-opt" "seccomp=$seccomp_profile")
        log_info "  Seccomp:  enabled"
    fi

    # Mount project directory
    if [[ "$SANDBOX_READONLY" == "true" ]]; then
        docker_args+=("--volume" "$PROJECT_DIR:/workspace:ro")
        # Need a writable .loki directory
        docker_args+=("--volume" "loki-sandbox-state:/workspace/.loki:rw")
    else
        docker_args+=("--volume" "$PROJECT_DIR:/workspace:rw")
    fi

    # Mount git config (read-only)
    if [[ -f "$HOME/.gitconfig" ]]; then
        docker_args+=("--volume" "$HOME/.gitconfig:/root/.gitconfig:ro")
    fi

    # SSH agent forwarding (more secure than mounting .ssh directory)
    # Only forward if SSH agent is available
    if [[ -n "${SSH_AUTH_SOCK:-}" ]]; then
        docker_args+=("--volume" "$SSH_AUTH_SOCK:/ssh-agent:ro")
        docker_args+=("--env" "SSH_AUTH_SOCK=/ssh-agent")
    elif [[ -d "$HOME/.ssh" ]]; then
        # Fallback: mount only known_hosts and public keys (NOT private keys)
        if [[ -f "$HOME/.ssh/known_hosts" ]]; then
            docker_args+=("--volume" "$HOME/.ssh/known_hosts:/home/loki/.ssh/known_hosts:ro")
        fi
        log_warn "SSH agent not available. Git operations may require manual auth."
    fi

    # Mount GitHub CLI config (read-only)
    if [[ -d "$HOME/.config/gh" ]]; then
        docker_args+=("--volume" "$HOME/.config/gh:/root/.config/gh:ro")
    fi

    # Pass API keys as environment variables (more secure than mounting files)
    if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
        docker_args+=("--env" "ANTHROPIC_API_KEY")
    fi
    if [[ -n "${OPENAI_API_KEY:-}" ]]; then
        docker_args+=("--env" "OPENAI_API_KEY")
    fi
    if [[ -n "${GOOGLE_API_KEY:-}" ]]; then
        docker_args+=("--env" "GOOGLE_API_KEY")
    fi
    if [[ -n "${GITHUB_TOKEN:-}" ]]; then
        docker_args+=("--env" "GITHUB_TOKEN")
    fi
    if [[ -n "${GH_TOKEN:-}" ]]; then
        docker_args+=("--env" "GH_TOKEN")
    fi

    # Loki configuration
    docker_args+=(
        "--env" "LOKI_PROVIDER=$provider"
        "--env" "LOKI_SANDBOX_MODE=true"
        "--env" "LOKI_NOTIFICATIONS=false"
        "--env" "LOKI_DASHBOARD=true"
    )

    # Expose ports
    docker_args+=(
        "--publish" "$API_PORT:9898"
        "--publish" "$DASHBOARD_PORT:57374"
    )

    # Working directory
    docker_args+=("--workdir" "/workspace")

    # Image and command
    docker_args+=("$SANDBOX_IMAGE")

    # Build loki command
    local loki_cmd="loki start"
    if [[ -n "$prd_path" ]]; then
        # Convert to container path
        local container_prd="/workspace/$(realpath --relative-to="$PROJECT_DIR" "$prd_path" 2>/dev/null || echo "$prd_path")"
        loki_cmd="$loki_cmd $container_prd"
    fi
    loki_cmd="$loki_cmd --provider $provider"

    docker_args+=("bash" "-c" "$loki_cmd")

    # Run container
    local container_id
    container_id=$(docker "${docker_args[@]}")

    log_success "Sandbox started: ${container_id:0:12}"
    log_info ""
    log_info "Access:"
    log_info "  Dashboard: http://localhost:$DASHBOARD_PORT"
    log_info "  API:       http://localhost:$API_PORT"
    log_info ""
    log_info "Commands:"
    log_info "  loki sandbox logs     - View logs"
    log_info "  loki sandbox shell    - Open shell in container"
    log_info "  loki sandbox stop     - Stop sandbox"
}

stop_sandbox() {
    check_docker

    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_info "Stopping sandbox: $CONTAINER_NAME"

        # Try graceful stop first (touch STOP file)
        docker exec "$CONTAINER_NAME" touch /workspace/.loki/STOP 2>/dev/null || true

        # Wait a bit for graceful shutdown
        sleep 2

        # Force stop if still running
        docker stop --time 10 "$CONTAINER_NAME" 2>/dev/null || true
        docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

        log_success "Sandbox stopped"
    else
        log_warn "No running sandbox found"
    fi
}

sandbox_status() {
    check_docker

    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_success "Sandbox is running: $CONTAINER_NAME"
        echo ""
        docker ps --filter "name=$CONTAINER_NAME" --format "table {{.ID}}\t{{.Status}}\t{{.Ports}}"
        echo ""

        # Try to get loki status
        log_info "Loki Status:"
        docker exec "$CONTAINER_NAME" loki status 2>/dev/null || log_warn "Could not get loki status"
    else
        log_warn "Sandbox is not running"

        # Check for stopped container
        if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
            log_info "Stopped container exists. Use 'loki sandbox start' to restart."
        fi
    fi
}

sandbox_logs() {
    local lines="${1:-100}"
    check_docker

    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        docker logs --tail "$lines" -f "$CONTAINER_NAME"
    else
        log_error "Sandbox is not running"
        exit 1
    fi
}

sandbox_shell() {
    check_docker

    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_info "Opening shell in sandbox..."
        docker exec -it "$CONTAINER_NAME" bash
    else
        log_error "Sandbox is not running"
        exit 1
    fi
}

sandbox_build() {
    check_docker
    build_sandbox_image
}

show_help() {
    echo -e "${BOLD}Loki Mode Docker Sandbox${NC}"
    echo ""
    echo "Usage: loki sandbox <command> [options]"
    echo ""
    echo "Commands:"
    echo "  start [PRD]    Start sandbox with optional PRD"
    echo "  stop           Stop running sandbox"
    echo "  status         Check sandbox status"
    echo "  logs [N]       View last N log lines (default: 100)"
    echo "  shell          Open bash shell in sandbox"
    echo "  build          Build/rebuild sandbox image"
    echo ""
    echo "Environment Variables:"
    echo "  LOKI_SANDBOX_IMAGE    Docker image (default: loki-mode:sandbox)"
    echo "  LOKI_SANDBOX_NETWORK  Network mode: bridge, none, host (default: bridge)"
    echo "  LOKI_SANDBOX_CPUS     CPU limit (default: 2)"
    echo "  LOKI_SANDBOX_MEMORY   Memory limit (default: 4g)"
    echo "  LOKI_SANDBOX_READONLY Mount project read-only (default: false)"
    echo ""
    echo "Security Features:"
    echo "  - Seccomp profile restricts syscalls"
    echo "  - No new privileges flag"
    echo "  - Dropped capabilities"
    echo "  - Resource limits (CPU, memory, PIDs)"
    echo "  - API keys passed as env vars (not mounted)"
    echo ""
    echo "Examples:"
    echo "  loki sandbox start                    # Start with defaults"
    echo "  loki sandbox start ./prd.md           # Start with PRD"
    echo "  LOKI_SANDBOX_MEMORY=8g loki sandbox start  # 8GB memory limit"
    echo "  LOKI_SANDBOX_NETWORK=none loki sandbox start  # No network"
}

#===============================================================================
# Main
#===============================================================================

main() {
    local command="${1:-help}"
    shift || true

    case "$command" in
        start)
            start_sandbox "$@"
            ;;
        stop)
            stop_sandbox
            ;;
        status)
            sandbox_status
            ;;
        logs)
            sandbox_logs "$@"
            ;;
        shell)
            sandbox_shell
            ;;
        build)
            sandbox_build
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            log_error "Unknown command: $command"
            show_help
            exit 1
            ;;
    esac
}

main "$@"
