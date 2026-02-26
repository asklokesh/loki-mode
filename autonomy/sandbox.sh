#!/usr/bin/env bash
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
# Normalize PROJECT_DIR (remove trailing slash)
PROJECT_DIR="${PROJECT_DIR%/}"

# Container name includes path hash to avoid collisions between similarly-named projects
# macOS uses md5 instead of md5sum
PROJECT_HASH=$(echo "$PROJECT_DIR" | (md5sum 2>/dev/null || md5 -r 2>/dev/null || echo "$$") | cut -c1-8)
CONTAINER_NAME="loki-sandbox-$(basename "$PROJECT_DIR" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')-${PROJECT_HASH}"

# Sandbox settings
SANDBOX_IMAGE="${LOKI_SANDBOX_IMAGE:-loki-mode:sandbox}"
SANDBOX_NETWORK="${LOKI_SANDBOX_NETWORK:-bridge}"
SANDBOX_CPUS="${LOKI_SANDBOX_CPUS:-2}"
SANDBOX_MEMORY="${LOKI_SANDBOX_MEMORY:-4g}"
SANDBOX_READONLY="${LOKI_SANDBOX_READONLY:-false}"

# API ports
API_PORT="${LOKI_DASHBOARD_PORT:-57374}"
DASHBOARD_PORT="${LOKI_DASHBOARD_PORT:-57374}"

# Security: Prompt injection disabled by default for enterprise security
PROMPT_INJECTION_ENABLED="${LOKI_PROMPT_INJECTION:-false}"

#===============================================================================
# Docker Credential Mount Presets
#===============================================================================

# Preset definitions: "host_path:container_path:mode"
# Container runs as user 'loki' (UID 1000), so mount to /home/loki/
declare -A DOCKER_MOUNT_PRESETS
DOCKER_MOUNT_PRESETS=(
    [gh]="$HOME/.config/gh:/home/loki/.config/gh:ro"
    [git]="$HOME/.gitconfig:/home/loki/.gitconfig:ro"
    [ssh]="$HOME/.ssh:/home/loki/.ssh:ro"
    [aws]="$HOME/.aws:/home/loki/.aws:ro"
    [azure]="$HOME/.azure:/home/loki/.azure:ro"
    [kube]="$HOME/.kube:/home/loki/.kube:ro"
    [terraform]="$HOME/.terraform.d:/home/loki/.terraform.d:ro"
    [gcloud]="$HOME/.config/gcloud:/home/loki/.config/gcloud:ro"
    [npm]="$HOME/.npmrc:/home/loki/.npmrc:ro"
)

# Environment variables auto-passed per preset (comma-separated)
declare -A DOCKER_ENV_PRESETS
DOCKER_ENV_PRESETS=(
    [aws]="AWS_REGION,AWS_PROFILE,AWS_DEFAULT_REGION"
    [azure]="AZURE_SUBSCRIPTION_ID,AZURE_TENANT_ID"
    [gcloud]="GOOGLE_PROJECT,GOOGLE_REGION,GCLOUD_PROJECT"
    [terraform]="TF_VAR_*"
)

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

# Check if a port is available
check_port_available() {
    local port="$1"
    if command -v lsof &>/dev/null; then
        ! lsof -i ":$port" &>/dev/null
    elif command -v nc &>/dev/null; then
        ! nc -z localhost "$port" 2>/dev/null
    else
        # Assume available if we can't check
        return 0
    fi
}

# Validate project directory
validate_project_dir() {
    if [[ ! -d "$PROJECT_DIR" ]]; then
        log_error "Project directory does not exist: $PROJECT_DIR"
        return 1
    fi
    if [[ ! -r "$PROJECT_DIR" ]]; then
        log_error "Project directory is not readable: $PROJECT_DIR"
        return 1
    fi
    if [[ "$SANDBOX_READONLY" != "true" ]] && [[ ! -w "$PROJECT_DIR" ]]; then
        log_warn "Project directory is not writable: $PROJECT_DIR"
        log_info "Consider using LOKI_SANDBOX_READONLY=true"
    fi
    return 0
}

# Warn about API keys based on provider
warn_missing_api_keys() {
    local provider="$1"
    case "$provider" in
        claude)
            if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
                log_warn "ANTHROPIC_API_KEY not set - Claude commands will fail inside container"
            fi
            ;;
        codex)
            if [[ -z "${OPENAI_API_KEY:-}" ]]; then
                log_warn "OPENAI_API_KEY not set - Codex commands will fail inside container"
            fi
            ;;
        gemini)
            if [[ -z "${GOOGLE_API_KEY:-}" ]]; then
                log_warn "GOOGLE_API_KEY not set - Gemini commands will fail inside container"
            fi
            ;;
    esac
}

# Cleanup handler for signals
cleanup_container() {
    log_warn "Interrupted - cleaning up container..."
    docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
    exit 130
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
# Git Worktree Sandbox (Fallback for non-Docker environments)
#===============================================================================

# Worktree sandbox settings
WORKTREE_PREFIX="loki-sandbox"
WORKTREE_BASE="${LOKI_WORKTREE_BASE:-${TMPDIR:-/tmp}}"
WORKTREE_STATE_FILE="${PROJECT_DIR}/.loki/sandbox/worktree-state.json"

# Check if Docker Desktop Sandbox is available (microVM-based isolation)
is_docker_desktop_sandbox_available() {
    command -v docker &>/dev/null && docker sandbox version &>/dev/null 2>&1
}

# Check if Docker is available (non-fatal version)
is_docker_available() {
    command -v docker &>/dev/null && docker info &>/dev/null 2>&1
}

# Check if git worktree is available
is_git_available() {
    command -v git &>/dev/null && git rev-parse --git-dir &>/dev/null 2>&1
}

# Detect which sandbox mode to use
# Priority: docker-desktop > docker > worktree
detect_sandbox_mode() {
    local requested="${1:-auto}"

    case "$requested" in
        docker-desktop)
            if is_docker_desktop_sandbox_available; then
                echo "docker-desktop"
            else
                log_error "Docker Desktop Sandbox not available (requires Docker Desktop 4.58+)"
                return 1
            fi
            ;;
        docker)
            if is_docker_available; then
                echo "docker"
            else
                log_error "Docker requested but not available"
                return 1
            fi
            ;;
        worktree)
            if is_git_available; then
                echo "worktree"
            else
                log_error "Git not available for worktree sandbox"
                return 1
            fi
            ;;
        auto|*)
            if is_docker_desktop_sandbox_available; then
                echo "docker-desktop"
            elif is_docker_available; then
                echo "docker"
            elif is_git_available; then
                log_warn "Docker not available - using worktree sandbox (soft isolation)"
                echo "worktree"
            else
                log_error "Neither Docker nor Git available for sandbox mode"
                return 1
            fi
            ;;
    esac
}

# Create a worktree sandbox
create_worktree_sandbox() {
    local prd_path="${1:-}"
    local provider="${LOKI_PROVIDER:-claude}"

    local timestamp
    timestamp=$(date +%Y%m%d-%H%M%S)
    local sandbox_name="${WORKTREE_PREFIX}-${timestamp}"
    local sandbox_branch="${WORKTREE_PREFIX}-${timestamp}"
    local sandbox_path="${WORKTREE_BASE}/${sandbox_name}"

    log_warn ""
    log_warn "=========================================="
    log_warn "  WORKTREE SANDBOX - SOFT ISOLATION ONLY"
    log_warn "=========================================="
    log_warn ""
    log_warn "This provides workspace isolation but NOT:"
    log_warn "  - Filesystem isolation (can access any file)"
    log_warn "  - Network isolation (full network access)"
    log_warn "  - Process isolation (no resource limits)"
    log_warn ""
    log_warn "For full isolation, install Docker."
    log_warn ""

    log_info "Creating worktree sandbox..."
    log_info "  Location: $sandbox_path"
    log_info "  Branch:   $sandbox_branch"

    # Check for existing sandbox
    if [[ -f "$WORKTREE_STATE_FILE" ]]; then
        local existing_path
        existing_path=$(jq -r '.sandbox_path // empty' "$WORKTREE_STATE_FILE" 2>/dev/null)
        if [[ -n "$existing_path" ]] && [[ -d "$existing_path" ]]; then
            log_warn "Existing sandbox found: $existing_path"
            log_info "Use 'loki sandbox stop' to stop it first."
            return 1
        fi
    fi

    # Create branch for sandbox
    if ! git branch "$sandbox_branch" HEAD 2>/dev/null; then
        log_error "Failed to create sandbox branch. Are you in a git repository?"
        return 1
    fi

    # Create worktree
    if ! git worktree add "$sandbox_path" "$sandbox_branch" 2>/dev/null; then
        git branch -D "$sandbox_branch" 2>/dev/null
        log_error "Failed to create worktree at $sandbox_path"
        return 1
    fi

    # Set up sandbox environment
    mkdir -p "$sandbox_path/.loki/"{state,logs,signals,queue,memory}

    # Copy essential files
    for file in ".loki/CONTINUITY.md" ".loki/config.yaml" "SKILL.md" "CLAUDE.md"; do
        if [[ -f "$PROJECT_DIR/$file" ]]; then
            mkdir -p "$(dirname "$sandbox_path/$file")"
            cp "$PROJECT_DIR/$file" "$sandbox_path/$file" 2>/dev/null || true
        fi
    done

    # Create sandbox marker
    cat > "$sandbox_path/.loki/SANDBOX_MODE" << EOF
ISOLATION_TYPE=worktree
CREATED_AT=$(date -Iseconds)
PARENT_DIR=$PROJECT_DIR
EOF

    # Save state
    mkdir -p "$(dirname "$WORKTREE_STATE_FILE")"
    cat > "$WORKTREE_STATE_FILE" << EOF
{
    "sandbox_path": "$sandbox_path",
    "sandbox_branch": "$sandbox_branch",
    "created_at": "$(date -Iseconds)",
    "provider": "$provider",
    "prd_path": "$prd_path",
    "status": "created",
    "isolation_type": "worktree"
}
EOF

    log_success "Worktree sandbox created: $sandbox_path"
    return 0
}

# Start loki in worktree sandbox
start_worktree_sandbox() {
    local prd_path="${1:-}"
    local provider="${LOKI_PROVIDER:-claude}"

    # Create sandbox if needed
    if ! [[ -f "$WORKTREE_STATE_FILE" ]]; then
        create_worktree_sandbox "$prd_path" || return 1
    fi

    local sandbox_path
    sandbox_path=$(jq -r '.sandbox_path' "$WORKTREE_STATE_FILE")

    if [[ ! -d "$sandbox_path" ]]; then
        log_error "Sandbox path does not exist: $sandbox_path"
        rm -f "$WORKTREE_STATE_FILE"
        return 1
    fi

    log_info "Starting Loki in worktree sandbox..."
    log_info "  Path:     $sandbox_path"
    log_info "  Provider: $provider"

    # Build loki command
    local loki_cmd="$SKILL_DIR/autonomy/run.sh"
    if [[ -n "$prd_path" ]]; then
        if [[ -f "$sandbox_path/$prd_path" ]]; then
            loki_cmd="$loki_cmd $prd_path"
        elif [[ -f "$prd_path" ]]; then
            cp "$prd_path" "$sandbox_path/" 2>/dev/null || true
            loki_cmd="$loki_cmd $(basename "$prd_path")"
        fi
    fi
    loki_cmd="$loki_cmd --provider $provider"

    # Set environment
    export LOKI_SANDBOX_MODE=true
    export LOKI_SANDBOX_TYPE=worktree
    export LOKI_NOTIFICATIONS=false

    log_info ""
    log_info "Commands (in another terminal):"
    log_info "  loki sandbox status      - Check status"
    log_info "  loki sandbox prompt 'msg' - Send prompt"
    log_info "  loki sandbox stop        - Stop sandbox"
    log_info ""

    # Run loki in sandbox directory
    cd "$sandbox_path" && $loki_cmd
}

# Stop worktree sandbox
stop_worktree_sandbox() {
    if [[ ! -f "$WORKTREE_STATE_FILE" ]]; then
        log_warn "No active worktree sandbox found"
        return 0
    fi

    local sandbox_path
    sandbox_path=$(jq -r '.sandbox_path' "$WORKTREE_STATE_FILE")
    local sandbox_branch
    sandbox_branch=$(jq -r '.sandbox_branch' "$WORKTREE_STATE_FILE")

    log_info "Stopping worktree sandbox..."

    # Send stop signal
    if [[ -d "$sandbox_path" ]]; then
        touch "$sandbox_path/.loki/STOP" 2>/dev/null || true
    fi

    # Cleanup
    if [[ "${LOKI_SANDBOX_CLEANUP:-true}" == "true" ]]; then
        log_info "Cleaning up worktree..."

        if [[ -n "$sandbox_path" ]] && [[ -d "$sandbox_path" ]]; then
            git worktree remove "$sandbox_path" --force 2>/dev/null || rm -rf "$sandbox_path" 2>/dev/null
        fi

        if [[ -n "$sandbox_branch" ]]; then
            git branch -D "$sandbox_branch" 2>/dev/null || true
        fi

        git worktree prune 2>/dev/null || true
        rm -f "$WORKTREE_STATE_FILE"

        log_success "Worktree sandbox cleaned up"
    else
        log_info "Sandbox preserved at: $sandbox_path"
        log_info "Run 'loki sandbox cleanup' to remove."
    fi
}

# Worktree sandbox status
worktree_sandbox_status() {
    if [[ ! -f "$WORKTREE_STATE_FILE" ]]; then
        log_info "No active worktree sandbox"
        return 0
    fi

    local sandbox_path
    sandbox_path=$(jq -r '.sandbox_path' "$WORKTREE_STATE_FILE")
    local sandbox_branch
    sandbox_branch=$(jq -r '.sandbox_branch' "$WORKTREE_STATE_FILE")
    local created_at
    created_at=$(jq -r '.created_at' "$WORKTREE_STATE_FILE")

    echo ""
    echo -e "${BOLD}Worktree Sandbox Status${NC}"
    echo "========================"
    echo ""
    echo -e "  Path:    ${CYAN}$sandbox_path${NC}"
    echo -e "  Branch:  $sandbox_branch"
    echo -e "  Created: $created_at"

    if [[ -d "$sandbox_path" ]]; then
        local disk_usage
        disk_usage=$(du -sh "$sandbox_path" 2>/dev/null | cut -f1)
        echo -e "  Disk:    $disk_usage"

        if [[ -f "$sandbox_path/.loki/STOP" ]]; then
            echo -e "  Status:  ${YELLOW}Stopping${NC}"
        else
            echo -e "  Status:  ${GREEN}Active${NC}"
        fi
    else
        echo -e "  Status:  ${RED}Missing${NC}"
    fi

    echo ""
    echo -e "${YELLOW}[SOFT ISOLATION]${NC} - No filesystem/network/process isolation"
    echo ""
}

# Send prompt to worktree sandbox
worktree_sandbox_prompt() {
    local prompt="$*"

    # Security check: prompt injection disabled by default
    if [[ "$PROMPT_INJECTION_ENABLED" != "true" ]]; then
        log_error "Prompt injection is disabled for security"
        log_info ""
        log_info "To enable, set LOKI_PROMPT_INJECTION=true"
        log_info "  Example: LOKI_PROMPT_INJECTION=true loki sandbox prompt 'your message'"
        log_info ""
        log_warn "WARNING: Only enable in trusted environments"
        return 1
    fi

    if [[ -z "$prompt" ]]; then
        log_error "Usage: loki sandbox prompt <your message>"
        return 1
    fi

    if [[ ! -f "$WORKTREE_STATE_FILE" ]]; then
        log_error "No active worktree sandbox"
        return 1
    fi

    local sandbox_path
    sandbox_path=$(jq -r '.sandbox_path' "$WORKTREE_STATE_FILE")

    if [[ ! -d "$sandbox_path" ]]; then
        log_error "Sandbox path does not exist"
        return 1
    fi

    # Use printf to safely write prompt without interpretation
    printf '%s\n' "$prompt" > "$sandbox_path/.loki/HUMAN_INPUT.md"
    log_success "Prompt sent to worktree sandbox"
    log_info "Check $sandbox_path/.loki/logs/ for response"
}

# Cleanup orphaned worktrees
cleanup_worktrees() {
    log_info "Scanning for orphaned sandbox worktrees..."

    local found=0
    while IFS= read -r line; do
        if [[ "$line" == *"$WORKTREE_PREFIX"* ]]; then
            log_info "  Found: $line"
            ((found++))
        fi
    done < <(git worktree list 2>/dev/null)

    if [[ $found -eq 0 ]]; then
        log_info "No sandbox worktrees found"
        return 0
    fi

    log_info "Pruning worktrees..."
    git worktree prune 2>/dev/null || true

    # Clean up orphaned branches
    local branches
    branches=$(git branch --list "${WORKTREE_PREFIX}*" 2>/dev/null)
    while IFS= read -r branch; do
        branch=$(echo "$branch" | tr -d '* ')
        if [[ -n "$branch" ]]; then
            log_info "  Removing branch: $branch"
            git branch -D "$branch" 2>/dev/null || true
        fi
    done <<< "$branches"

    rm -f "$WORKTREE_STATE_FILE" 2>/dev/null
    log_success "Cleanup complete"
}

#===============================================================================
# Docker Desktop Sandbox (microVM-based isolation via Docker Desktop 4.58+)
#===============================================================================

# Desktop sandbox name follows same pattern as container name
DESKTOP_SANDBOX_NAME="$CONTAINER_NAME"

# Install provider CLI inside sandbox if not pre-installed
_desktop_install_provider_cli() {
    local sandbox_name="$1" provider="$2"
    case "$provider" in
        codex)
            if ! docker sandbox exec "$sandbox_name" which codex &>/dev/null 2>&1; then
                log_info "Installing Codex CLI in sandbox (one-time)..."
                docker sandbox exec "$sandbox_name" npm install -g @openai/codex 2>&1 | tail -1
            fi
            ;;
        gemini)
            if ! docker sandbox exec "$sandbox_name" which gemini &>/dev/null 2>&1; then
                log_info "Installing Gemini CLI in sandbox (one-time)..."
                docker sandbox exec "$sandbox_name" npm install -g @google/gemini-cli 2>&1 | tail -1
            fi
            ;;
        # claude is pre-installed in the sandbox template
    esac
}

# Build environment variable args for docker sandbox exec
_desktop_build_env_args() {
    DESKTOP_ENV_ARGS=()
    [[ -n "${ANTHROPIC_API_KEY:-}" ]] && DESKTOP_ENV_ARGS+=("-e" "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
    [[ -n "${OPENAI_API_KEY:-}" ]] && DESKTOP_ENV_ARGS+=("-e" "OPENAI_API_KEY=$OPENAI_API_KEY")
    [[ -n "${GOOGLE_API_KEY:-}" ]] && DESKTOP_ENV_ARGS+=("-e" "GOOGLE_API_KEY=$GOOGLE_API_KEY")
    [[ -n "${GITHUB_TOKEN:-}" ]] && DESKTOP_ENV_ARGS+=("-e" "GITHUB_TOKEN=$GITHUB_TOKEN")
    [[ -n "${GH_TOKEN:-}" ]] && DESKTOP_ENV_ARGS+=("-e" "GH_TOKEN=$GH_TOKEN")
    # Forward all LOKI_* env vars
    local var
    while IFS= read -r var; do
        [[ -n "$var" ]] && DESKTOP_ENV_ARGS+=("-e" "$var=${!var}")
    done < <(compgen -v LOKI_ 2>/dev/null || true)
}

start_docker_desktop_sandbox() {
    local prd_path="${1:-}"
    local provider="${LOKI_PROVIDER:-claude}"

    validate_project_dir || return 1
    warn_missing_api_keys "$provider"

    # Check if sandbox already exists
    local sandbox_exists=false
    if docker sandbox ls 2>/dev/null | grep -q "$DESKTOP_SANDBOX_NAME"; then
        sandbox_exists=true
    fi

    if [[ "$sandbox_exists" == "false" ]]; then
        log_info "Creating Docker Desktop Sandbox (microVM)..."
        log_info "  Workspace: $PROJECT_DIR"
        log_info "  Agent:     claude (provider: $provider)"
        docker sandbox create --name "$DESKTOP_SANDBOX_NAME" claude "$PROJECT_DIR" || {
            log_error "Failed to create Docker Desktop Sandbox"
            log_info "Falling back to Docker container sandbox..."
            start_sandbox "$@"
            return $?
        }
        log_success "Sandbox created: $DESKTOP_SANDBOX_NAME"
    else
        log_info "Using existing sandbox: $DESKTOP_SANDBOX_NAME"
    fi

    # Install provider CLI if needed (codex/gemini not pre-installed)
    _desktop_install_provider_cli "$DESKTOP_SANDBOX_NAME" "$provider"

    # Build environment variable args
    _desktop_build_env_args

    # Build loki command
    local loki_cmd="bash ${PROJECT_DIR}/autonomy/run.sh"
    if [[ -n "$prd_path" ]]; then
        local abs_prd
        abs_prd=$(cd "$(dirname "$prd_path")" && pwd)/$(basename "$prd_path")
        loki_cmd="$loki_cmd $abs_prd"
    fi
    loki_cmd="LOKI_PROVIDER=$provider LOKI_SANDBOX_MODE=true LOKI_DASHBOARD=false $loki_cmd"

    log_info ""
    log_info "Starting Loki Mode in Docker Desktop Sandbox..."
    log_info "  Isolation: microVM (hypervisor-based)"
    log_info "  Provider:  $provider"
    log_info "  Sandbox:   $DESKTOP_SANDBOX_NAME"
    log_info "  Workspace: $PROJECT_DIR (synced at same path)"
    log_info ""
    log_info "  Private Docker daemon available inside sandbox"
    log_info "  Dashboard: run 'loki dashboard' on host (reads synced .loki/ files)"
    log_info ""
    log_info "Commands:"
    log_info "  loki sandbox status     - Check sandbox status"
    log_info "  loki sandbox shell      - Open shell in sandbox"
    log_info "  loki sandbox stop       - Stop sandbox"
    log_info ""

    # Execute loki inside sandbox (use -it only when stdin is a terminal)
    local tty_args="-i"
    if [ -t 0 ]; then
        tty_args="-it"
    fi
    docker sandbox exec $tty_args \
        -w "$PROJECT_DIR" \
        ${DESKTOP_ENV_ARGS[@]+"${DESKTOP_ENV_ARGS[@]}"} \
        "$DESKTOP_SANDBOX_NAME" \
        bash -c "$loki_cmd"
}

# shellcheck disable=SC2120
stop_docker_desktop_sandbox() {
    local remove="${1:-false}"

    if ! docker sandbox ls 2>/dev/null | grep -q "$DESKTOP_SANDBOX_NAME"; then
        log_error "Sandbox not found: $DESKTOP_SANDBOX_NAME"
        return 1
    fi

    # Signal loki to stop gracefully
    docker sandbox exec "$DESKTOP_SANDBOX_NAME" \
        bash -c "touch ${PROJECT_DIR}/.loki/STOP 2>/dev/null" 2>/dev/null || true

    log_info "Stopping sandbox: $DESKTOP_SANDBOX_NAME"
    docker sandbox stop "$DESKTOP_SANDBOX_NAME" 2>/dev/null || true

    if [[ "$remove" == "true" ]]; then
        log_info "Removing sandbox: $DESKTOP_SANDBOX_NAME"
        docker sandbox rm "$DESKTOP_SANDBOX_NAME" 2>/dev/null || true
    fi

    log_success "Sandbox stopped"
}

docker_desktop_sandbox_status() {
    local found=false
    while IFS= read -r line; do
        if echo "$line" | grep -q "$DESKTOP_SANDBOX_NAME"; then
            found=true
            echo "$line"
        fi
    done < <(docker sandbox ls 2>/dev/null)

    if [[ "$found" == "false" ]]; then
        log_info "No Docker Desktop Sandbox found for this project"
        log_info "Expected name: $DESKTOP_SANDBOX_NAME"
        return 1
    fi

    # If sandbox is running, get loki status
    if docker sandbox ls 2>/dev/null | grep "$DESKTOP_SANDBOX_NAME" | grep -q "running"; then
        echo ""
        docker sandbox exec -w "$PROJECT_DIR" "$DESKTOP_SANDBOX_NAME" \
            bash -c "bash ${PROJECT_DIR}/autonomy/loki status" 2>/dev/null || true
    fi
}

docker_desktop_sandbox_shell() {
    if ! docker sandbox ls 2>/dev/null | grep "$DESKTOP_SANDBOX_NAME" | grep -q "running"; then
        log_error "Sandbox is not running: $DESKTOP_SANDBOX_NAME"
        log_info "Start it with: loki sandbox start"
        return 1
    fi

    log_info "Opening shell in Docker Desktop Sandbox..."
    docker sandbox exec -it -w "$PROJECT_DIR" "$DESKTOP_SANDBOX_NAME" bash
}

docker_desktop_sandbox_logs() {
    local lines="${1:-100}"
    if ! docker sandbox ls 2>/dev/null | grep -q "$DESKTOP_SANDBOX_NAME"; then
        log_error "Sandbox not found: $DESKTOP_SANDBOX_NAME"
        return 1
    fi

    docker sandbox exec -w "$PROJECT_DIR" "$DESKTOP_SANDBOX_NAME" \
        bash -c "cat .loki/logs/*.log 2>/dev/null | tail -${lines}" || \
        log_warn "No logs found in .loki/logs/"
}

docker_desktop_sandbox_prompt() {
    local message="${1:-}"
    if [[ -z "$message" ]]; then
        log_error "Usage: loki sandbox prompt <message>"
        return 1
    fi

    if ! docker sandbox ls 2>/dev/null | grep "$DESKTOP_SANDBOX_NAME" | grep -q "running"; then
        log_error "Sandbox is not running"
        return 1
    fi

    _desktop_build_env_args
    docker sandbox exec -w "$PROJECT_DIR" \
        ${DESKTOP_ENV_ARGS[@]+"${DESKTOP_ENV_ARGS[@]}"} \
        "$DESKTOP_SANDBOX_NAME" \
        bash -c "printf '%s\n' \"\$1\" > ${PROJECT_DIR}/.loki/HUMAN_INPUT.md" -- "$message"

    log_success "Prompt sent to sandbox"
}

docker_desktop_sandbox_run() {
    local cmd="${*}"
    if [[ -z "$cmd" ]]; then
        log_error "Usage: loki sandbox run <command>"
        return 1
    fi

    if ! docker sandbox ls 2>/dev/null | grep "$DESKTOP_SANDBOX_NAME" | grep -q "running"; then
        log_error "Sandbox is not running"
        return 1
    fi

    _desktop_build_env_args
    docker sandbox exec -w "$PROJECT_DIR" \
        ${DESKTOP_ENV_ARGS[@]+"${DESKTOP_ENV_ARGS[@]}"} \
        "$DESKTOP_SANDBOX_NAME" \
        bash -c "$cmd"
}

#===============================================================================
# Docker Container Sandbox (standard Docker - fallback from Docker Desktop)
#===============================================================================

# Resolve Docker credential mount presets
# Reads from: .loki/config/settings.json dockerMounts, LOKI_DOCKER_MOUNTS env var
# Returns: string of -v and -e flags for docker run
resolve_docker_mounts() {
    local mount_args=""

    # Read configured presets (JSON array of strings)
    local presets_json=""
    if [[ -f "${PROJECT_DIR}/.loki/config/settings.json" ]]; then
        presets_json=$(python3 -c "
import json, sys
try:
    with open('${PROJECT_DIR}/.loki/config/settings.json') as f:
        print(json.dumps(json.load(f).get('dockerMounts', [])))
except: print('[]')
" 2>/dev/null || echo "[]")
    fi

    # Override with env var if set
    if [[ -n "${LOKI_DOCKER_MOUNTS:-}" ]]; then
        presets_json="$LOKI_DOCKER_MOUNTS"
    fi

    # Parse and resolve
    if [[ "$presets_json" != "[]" ]] && [[ "$presets_json" != "" ]]; then
        local preset_names
        preset_names=$(python3 -c "
import json, sys
try:
    data = json.loads(sys.argv[1])
    if isinstance(data, list):
        for item in data:
            print(item)
except: pass
" "$presets_json" 2>/dev/null || echo "")

        local name
        while IFS= read -r name; do
            [[ -z "$name" ]] && continue

            local preset_value="${DOCKER_MOUNT_PRESETS[$name]:-}"
            if [[ -z "$preset_value" ]]; then
                log_warn "Unknown Docker mount preset: $name"
                continue
            fi

            IFS=':' read -ra parts <<< "$preset_value"
            local host_path="${parts[0]}"
            local container_path="${parts[1]}"
            local mode="${parts[2]:-ro}"

            # Expand ~ and $HOME
            host_path=$(eval echo "$host_path" 2>/dev/null || echo "$host_path")

            # Only mount if host path exists
            if [[ -e "$host_path" ]]; then
                mount_args="$mount_args -v ${host_path}:${container_path}:${mode}"
                log_info "  Mount preset [$name]: $host_path -> $container_path ($mode)"
            fi

            # Add associated env vars
            local env_list="${DOCKER_ENV_PRESETS[$name]:-}"
            if [[ -n "$env_list" ]]; then
                IFS=',' read -ra env_names <<< "$env_list"
                local env_name
                for env_name in "${env_names[@]}"; do
                    if [[ "$env_name" == *"*" ]]; then
                        # Wildcard: pass all matching env vars
                        local prefix="${env_name%\*}"
                        while IFS='=' read -r key val; do
                            [[ "$key" == "$prefix"* ]] && [[ -n "$val" ]] && \
                                mount_args="$mount_args -e $key"
                        done < <(env)
                    elif [[ -n "${!env_name:-}" ]]; then
                        mount_args="$mount_args -e $env_name"
                    fi
                done
            fi
        done <<< "$preset_names"
    fi

    echo "$mount_args"
}

start_sandbox() {
    # Parse arguments: extract flags before positional args
    local prd_path=""
    local provider="${LOKI_PROVIDER:-claude}"
    local no_mounts=false
    local -a custom_mounts=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --mount)
                if [[ -n "${2:-}" ]]; then
                    custom_mounts+=("$2")
                    shift 2
                else
                    log_error "--mount requires HOST:CONTAINER:MODE argument"
                    return 1
                fi
                ;;
            --no-mounts)
                no_mounts=true
                shift
                ;;
            --provider)
                if [[ -n "${2:-}" ]]; then
                    provider="$2"
                    shift 2
                else
                    shift
                fi
                ;;
            *)
                # First non-flag argument is the PRD path
                if [[ -z "$prd_path" ]]; then
                    prd_path="$1"
                fi
                shift
                ;;
        esac
    done

    # Set up signal handler to cleanup on Ctrl+C
    trap cleanup_container INT TERM

    check_docker
    validate_project_dir || return 1
    ensure_image

    # Check port availability (unified dashboard/API port)
    if ! check_port_available "$DASHBOARD_PORT"; then
        log_error "Port $DASHBOARD_PORT is already in use"
        log_info "Set LOKI_DASHBOARD_PORT to use a different port"
        return 1
    fi

    # Warn about missing API keys
    warn_missing_api_keys "$provider"

    # Warn about network=none implications
    if [[ "$SANDBOX_NETWORK" == "none" ]]; then
        log_warn "Network disabled (--network=none)"
        log_warn "  - Git remote operations will fail"
        log_warn "  - Package installations will fail"
        log_warn "  - API calls to AI providers will fail"
    fi

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
        # SETUID/SETGID intentionally omitted: container runs as non-root (UID 1000)
        # and should not be able to change UID/GID, which would undermine isolation

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

    # Config self-protection: mount critical .loki/ paths as read-only
    # Prevents agents from corrupting council state, config, or audit trail
    if [[ -d "$PROJECT_DIR/.loki/council" ]]; then
        docker_args+=("--volume" "$PROJECT_DIR/.loki/council:/workspace/.loki/council:ro")
    fi
    if [[ -f "$PROJECT_DIR/.loki/config.yaml" ]]; then
        docker_args+=("--volume" "$PROJECT_DIR/.loki/config.yaml:/workspace/.loki/config.yaml:ro")
    fi

    # Mount git config (read-only) - mount to /home/loki since container runs as user loki
    if [[ -f "$HOME/.gitconfig" ]]; then
        docker_args+=("--volume" "$HOME/.gitconfig:/home/loki/.gitconfig:ro")
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

    # Mount GitHub CLI config (read-only) - mount to /home/loki since container runs as user loki
    if [[ -d "$HOME/.config/gh" ]]; then
        docker_args+=("--volume" "$HOME/.config/gh:/home/loki/.config/gh:ro")
    fi

    # Apply Docker credential mount presets (additive on top of defaults above)
    if [[ "$no_mounts" != "true" ]] && [[ "${LOKI_NO_DOCKER_MOUNTS:-}" != "true" ]]; then
        local preset_mounts
        preset_mounts=$(resolve_docker_mounts)
        if [[ -n "$preset_mounts" ]]; then
            # shellcheck disable=SC2206
            docker_args+=($preset_mounts)
        fi
    fi

    # Apply custom --mount arguments
    local custom_mount
    for custom_mount in "${custom_mounts[@]+"${custom_mounts[@]}"}"; do
        if [[ -n "$custom_mount" ]]; then
            IFS=':' read -ra mount_parts <<< "$custom_mount"
            local c_host="${mount_parts[0]:-}"
            local c_container="${mount_parts[1]:-}"
            local c_mode="${mount_parts[2]:-ro}"
            if [[ -n "$c_host" ]] && [[ -n "$c_container" ]]; then
                c_host=$(eval echo "$c_host" 2>/dev/null || echo "$c_host")
                if [[ -e "$c_host" ]]; then
                    docker_args+=("--volume" "${c_host}:${c_container}:${c_mode}")
                    log_info "  Custom mount: $c_host -> $c_container ($c_mode)"
                else
                    log_warn "Custom mount source does not exist: $c_host"
                fi
            else
                log_warn "Invalid mount format: $custom_mount (expected HOST:CONTAINER[:MODE])"
            fi
        fi
    done

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
        "--publish" "$API_PORT:57374"
    )

    # Expose additional ports for testing (e.g., LOKI_EXTRA_PORTS="3000:3000,8080:8080")
    if [[ -n "${LOKI_EXTRA_PORTS:-}" ]]; then
        IFS=',' read -ra EXTRA_PORTS <<< "$LOKI_EXTRA_PORTS"
        for port_mapping in "${EXTRA_PORTS[@]}"; do
            docker_args+=("--publish" "$port_mapping")
        done
    fi

    # Working directory
    docker_args+=("--workdir" "/workspace")

    # Override entrypoint to use bash (Dockerfile has loki as entrypoint)
    docker_args+=("--entrypoint" "/bin/bash")

    # Image and command
    docker_args+=("$SANDBOX_IMAGE")

    # Build loki command
    local loki_cmd="loki start"
    if [[ -n "$prd_path" ]]; then
        # Convert to container path (handle paths with spaces)
        local relative_prd
        relative_prd=$(realpath --relative-to="$PROJECT_DIR" "$prd_path" 2>/dev/null || basename "$prd_path")
        local container_prd="/workspace/${relative_prd}"
        # Quote path to handle spaces
        loki_cmd="$loki_cmd \"$container_prd\""
    fi
    loki_cmd="$loki_cmd --provider $provider"

    docker_args+=("-c" "$loki_cmd")

    # Run container
    local container_id
    container_id=$(docker "${docker_args[@]}")

    log_success "Sandbox started: ${container_id:0:12}"
    log_info ""
    log_info "Access:"
    log_info "  Dashboard: http://localhost:$DASHBOARD_PORT"
    log_info "  API:       http://localhost:$API_PORT"
    if [[ -n "${LOKI_EXTRA_PORTS:-}" ]]; then
        log_info "  Extra:     $LOKI_EXTRA_PORTS"
    fi
    log_info ""
    log_info "Commands:"
    log_info "  loki sandbox logs       - View logs"
    log_info "  loki sandbox shell      - Open shell in container"
    log_info "  loki sandbox stop       - Stop sandbox"
    log_info ""
    log_info "Testing (when ready):"
    log_info "  loki sandbox phase      - Check SDLC phase & testing tips"
    log_info "  loki sandbox test       - Run tests"
    log_info "  loki sandbox serve      - Start dev server"
    log_info "  loki sandbox prompt 'msg' - Send real-time prompt"
}

stop_sandbox() {
    check_docker

    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_info "Stopping sandbox: $CONTAINER_NAME"

        # Try graceful stop first (touch STOP file)
        docker exec "$CONTAINER_NAME" touch /workspace/.loki/STOP 2>/dev/null || true

        # Wait for graceful shutdown (check every second for up to 10 seconds)
        local waited=0
        while [ $waited -lt 10 ]; do
            if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
                log_success "Sandbox stopped gracefully"
                return 0
            fi
            sleep 1
            ((waited++))
        done

        # Force stop if still running
        log_info "Force stopping container..."
        docker stop --time 5 "$CONTAINER_NAME" 2>/dev/null || true
        docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

        log_success "Sandbox stopped"
    else
        log_warn "No running sandbox found"
    fi
}

# Send a prompt/directive to the running sandbox
sandbox_prompt() {
    local prompt="$*"

    # Security check: prompt injection disabled by default
    if [[ "$PROMPT_INJECTION_ENABLED" != "true" ]]; then
        log_error "Prompt injection is disabled for security"
        log_info ""
        log_info "To enable, set LOKI_PROMPT_INJECTION=true"
        log_info "  Example: LOKI_PROMPT_INJECTION=true loki sandbox prompt 'your message'"
        log_info ""
        log_warn "WARNING: Only enable in trusted environments"
        return 1
    fi

    if [[ -z "$prompt" ]]; then
        log_error "Usage: loki sandbox prompt <your message>"
        log_info "Example: loki sandbox prompt 'start the dev server and show me the URL'"
        return 1
    fi

    check_docker

    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_error "Sandbox is not running. Start it first with: loki sandbox start"
        return 1
    fi

    log_info "Sending prompt to sandbox..."

    # Write to HUMAN_INPUT.md inside the container
    # Use heredoc to avoid command injection via single quotes in prompt
    docker exec "$CONTAINER_NAME" bash -c 'cat > /workspace/.loki/HUMAN_INPUT.md' <<< "$prompt"

    log_success "Prompt sent. Loki will process it in the next iteration."
    log_info ""
    log_info "Watch the response with: loki sandbox logs"
    log_info "Or check status with: loki sandbox status"
}

# Run a command inside the sandbox and show output
sandbox_run() {
    local cmd="$*"

    if [[ -z "$cmd" ]]; then
        log_error "Usage: loki sandbox run <command>"
        log_info "Example: loki sandbox run 'npm run dev'"
        return 1
    fi

    check_docker

    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_error "Sandbox is not running"
        return 1
    fi

    log_info "Running command in sandbox: $cmd"
    docker exec -it "$CONTAINER_NAME" bash -c "cd /workspace && $cmd"
}

# Start a dev server inside the sandbox
sandbox_serve() {
    local port="${1:-3000}"

    check_docker

    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_error "Sandbox is not running"
        return 1
    fi

    log_info "Looking for dev server configuration..."

    # Detect project type and start appropriate server
    local serve_cmd=""

    if docker exec "$CONTAINER_NAME" test -f /workspace/package.json; then
        # Check for common dev server scripts
        local has_dev
        has_dev=$(docker exec "$CONTAINER_NAME" jq -r '.scripts.dev // empty' /workspace/package.json 2>/dev/null)
        local has_start
        has_start=$(docker exec "$CONTAINER_NAME" jq -r '.scripts.start // empty' /workspace/package.json 2>/dev/null)

        if [[ -n "$has_dev" ]]; then
            serve_cmd="npm run dev"
        elif [[ -n "$has_start" ]]; then
            serve_cmd="npm start"
        fi
    elif docker exec "$CONTAINER_NAME" test -f /workspace/requirements.txt; then
        # Python project
        if docker exec "$CONTAINER_NAME" test -f /workspace/manage.py; then
            serve_cmd="python manage.py runserver 0.0.0.0:$port"
        elif docker exec "$CONTAINER_NAME" test -f /workspace/app.py; then
            serve_cmd="python app.py"
        fi
    fi

    if [[ -z "$serve_cmd" ]]; then
        log_warn "Could not auto-detect dev server"
        log_info "Try: loki sandbox run 'your-dev-command'"
        return 1
    fi

    log_success "Starting dev server: $serve_cmd"
    log_info ""
    log_info "Access the app at:"
    log_info "  http://localhost:$port"
    log_info ""
    log_info "Press Ctrl+C to stop the server (sandbox continues running)"

    docker exec -it "$CONTAINER_NAME" bash -c "cd /workspace && $serve_cmd"
}

# Run tests inside the sandbox
sandbox_test() {
    local test_type="${1:-all}"

    check_docker

    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_error "Sandbox is not running"
        return 1
    fi

    log_info "Running tests in sandbox..."

    # Detect project type and test command
    local test_cmd=""

    if docker exec "$CONTAINER_NAME" test -f /workspace/package.json; then
        case "$test_type" in
            unit)
                test_cmd=$(docker exec "$CONTAINER_NAME" jq -r '.scripts["test:unit"] // .scripts.test // "npm test"' /workspace/package.json 2>/dev/null)
                ;;
            integration)
                test_cmd=$(docker exec "$CONTAINER_NAME" jq -r '.scripts["test:integration"] // empty' /workspace/package.json 2>/dev/null)
                [[ -z "$test_cmd" ]] && test_cmd="npm run test:integration"
                ;;
            e2e)
                if docker exec "$CONTAINER_NAME" test -d /workspace/node_modules/.bin/playwright; then
                    test_cmd="npx playwright test"
                elif docker exec "$CONTAINER_NAME" test -d /workspace/node_modules/.bin/cypress; then
                    test_cmd="npx cypress run"
                else
                    test_cmd=$(docker exec "$CONTAINER_NAME" jq -r '.scripts["test:e2e"] // empty' /workspace/package.json 2>/dev/null)
                fi
                ;;
            all|*)
                test_cmd=$(docker exec "$CONTAINER_NAME" jq -r '.scripts.test // "npm test"' /workspace/package.json 2>/dev/null)
                ;;
        esac
    elif docker exec "$CONTAINER_NAME" test -f /workspace/requirements.txt; then
        case "$test_type" in
            unit)
                test_cmd="pytest tests/unit/ -v"
                ;;
            integration)
                test_cmd="pytest tests/integration/ -v"
                ;;
            e2e)
                test_cmd="pytest tests/e2e/ -v"
                ;;
            all|*)
                test_cmd="pytest -v"
                ;;
        esac
    elif docker exec "$CONTAINER_NAME" test -f /workspace/Cargo.toml; then
        test_cmd="cargo test"
    elif docker exec "$CONTAINER_NAME" test -f /workspace/go.mod; then
        test_cmd="go test ./..."
    fi

    if [[ -z "$test_cmd" ]] || [[ "$test_cmd" == "null" ]]; then
        log_warn "Could not auto-detect test command"
        log_info "Supported test types: unit, integration, e2e, all"
        log_info "Or run: loki sandbox run 'your-test-command'"
        return 1
    fi

    log_success "Running: $test_cmd"
    docker exec -it "$CONTAINER_NAME" bash -c "cd /workspace && $test_cmd"
}

# Check SDLC phase and suggest testing
sandbox_phase() {
    check_docker

    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_error "Sandbox is not running"
        return 1
    fi

    # Get current phase from orchestrator state
    local phase
    phase=$(docker exec "$CONTAINER_NAME" bash -c \
        "python3 -c \"import json; print(json.load(open('/workspace/.loki/state/orchestrator.json')).get('currentPhase', 'UNKNOWN'))\" 2>/dev/null" \
        || echo "UNKNOWN")

    echo ""
    echo -e "${BOLD}Current SDLC Phase: ${CYAN}$phase${NC}"
    echo ""

    case "$phase" in
        BOOTSTRAP|DISCOVERY|ARCHITECTURE)
            log_info "Phase $phase - No testing required yet"
            log_info "Testing begins in DEVELOPMENT phase"
            ;;
        INFRASTRUCTURE)
            log_info "Phase $phase - Infrastructure testing"
            echo "  Recommended:"
            echo "    loki sandbox run 'docker-compose up -d'"
            echo "    loki sandbox run 'terraform plan'"
            ;;
        DEVELOPMENT)
            log_info "Phase $phase - Development testing recommended"
            echo ""
            echo "  Run dev server:"
            echo "    loki sandbox serve"
            echo ""
            echo "  Run unit tests:"
            echo "    loki sandbox test unit"
            echo ""
            echo "  Manual testing:"
            echo "    loki sandbox shell"
            ;;
        QA)
            log_info "Phase $phase - Full testing required"
            echo ""
            echo "  Run all tests:"
            echo "    loki sandbox test all"
            echo ""
            echo "  Run specific test suites:"
            echo "    loki sandbox test unit"
            echo "    loki sandbox test integration"
            echo "    loki sandbox test e2e"
            echo ""
            echo "  Interactive testing:"
            echo "    loki sandbox serve"
            echo "    loki sandbox shell"
            echo ""
            echo "  To report issues during testing:"
            echo "    loki sandbox prompt 'Found bug: describe the bug here'"
            ;;
        DEPLOYMENT)
            log_info "Phase $phase - Smoke testing"
            echo ""
            echo "  Run smoke tests:"
            echo "    loki sandbox run 'npm run test:smoke'"
            echo ""
            echo "  Check deployment status:"
            echo "    loki sandbox run 'curl -s http://localhost:3000/health'"
            ;;
        GROWTH|*)
            log_info "Phase $phase - Continuous testing"
            echo ""
            echo "  Run regression tests:"
            echo "    loki sandbox test all"
            echo ""
            echo "  Performance testing:"
            echo "    loki sandbox run 'npx k6 run tests/load.js'"
            ;;
    esac

    echo ""
}

# Expose additional ports (for development testing)
sandbox_expose() {
    local port="${1:-}"

    if [[ -z "$port" ]]; then
        log_error "Usage: loki sandbox expose <port>"
        log_info "Example: loki sandbox expose 8080"
        return 1
    fi

    check_docker

    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        log_error "Sandbox is not running"
        log_info "Note: Ports must be exposed when starting the sandbox"
        log_info "Set LOKI_EXTRA_PORTS='$port:$port' before running 'loki sandbox start'"
        return 1
    fi

    log_warn "Cannot expose ports on running container"
    log_info ""
    log_info "To expose additional ports, restart sandbox with:"
    echo ""
    echo "  LOKI_EXTRA_PORTS='$port:$port' loki sandbox start"
    echo ""
    log_info "Or access via sandbox shell:"
    echo "  loki sandbox shell"
    echo "  # Then run your server inside the container"
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
    echo -e "${BOLD}Loki Mode Sandbox${NC}"
    echo ""
    echo "Usage: loki sandbox <command> [options]"
    echo ""
    echo "Commands:"
    echo "  start [PRD]      Start sandbox with optional PRD"
    echo "  stop             Stop running sandbox"
    echo "  status           Check sandbox status"
    echo "  logs [N]         View last N log lines (default: 100)"
    echo "  shell            Open bash shell in sandbox"
    echo "  build            Build/rebuild sandbox image"
    echo "  cleanup          Remove orphaned sandbox worktrees/branches"
    echo ""
    echo "Interactive Commands (while sandbox is running):"
    echo "  prompt <msg>     Send a prompt/directive to Loki in real-time"
    echo "  run <cmd>        Run a command inside the sandbox"
    echo "  serve [port]     Auto-detect and start dev server (default port: 3000)"
    echo ""
    echo "Testing Commands:"
    echo "  test [type]      Run tests (type: unit, integration, e2e, all)"
    echo "  phase            Check SDLC phase and get testing suggestions"
    echo "  expose <port>    Show how to expose additional ports"
    echo ""
    echo "Mode Options:"
    echo "  --docker-desktop Force Docker Desktop Sandbox (microVM isolation)"
    echo "  --docker         Force Docker container sandbox (seccomp isolation)"
    echo "  --worktree       Force git worktree sandbox (soft isolation)"
    echo "  --auto           Auto-detect best mode (default)"
    echo ""
    echo "Sandbox Modes (priority order):"
    echo "  Docker Desktop   - microVM isolation via 'docker sandbox' (Docker Desktop 4.58+)"
    echo "    (default)        Hypervisor-based VM, private Docker daemon, pre-installed CLIs"
    echo "  Docker Container - Container isolation with seccomp, dropped capabilities,"
    echo "    (fallback)       resource limits, network control (Dockerfile.sandbox)"
    echo "  Worktree         - Git worktree isolation (last resort if no Docker)"
    echo "    (last resort)    Warning: No filesystem/network/process isolation"
    echo ""
    echo "Environment Variables:"
    echo "  LOKI_SANDBOX_IMAGE    Docker image (default: loki-mode:sandbox)"
    echo "  LOKI_SANDBOX_NETWORK  Network mode: bridge, none, host (default: bridge)"
    echo "  LOKI_SANDBOX_CPUS     CPU limit (default: 2)"
    echo "  LOKI_SANDBOX_MEMORY   Memory limit (default: 4g)"
    echo "  LOKI_SANDBOX_READONLY Mount project read-only (default: false)"
    echo "  LOKI_SANDBOX_CLEANUP  Auto-cleanup worktree on stop (default: true)"
    echo "  LOKI_EXTRA_PORTS      Expose extra ports (e.g., '3000:3000,8080:8080')"
    echo "  LOKI_PROMPT_INJECTION Enable real-time prompts (default: false)"
    echo ""
    echo "Security Features (Docker mode):"
    echo "  - Seccomp profile restricts syscalls"
    echo "  - No new privileges flag"
    echo "  - Dropped capabilities"
    echo "  - Resource limits (CPU, memory, PIDs)"
    echo "  - API keys passed as env vars (not mounted)"
    echo "  - Prompt injection DISABLED by default (enterprise security)"
    echo ""
    echo "Examples:"
    echo "  loki sandbox start                              # Start (auto-detect: Desktop > Docker > Worktree)"
    echo "  loki sandbox start --docker-desktop ./prd.md   # Force Docker Desktop microVM"
    echo "  loki sandbox start --docker ./prd.md           # Force Docker container mode"
    echo "  loki sandbox start --worktree                   # Force worktree mode"
    echo "  loki sandbox prompt 'start the app and show URL'  # Send prompt"
    echo "  loki sandbox serve                              # Start dev server"
    echo "  loki sandbox test                               # Run all tests"
    echo "  loki sandbox test unit                          # Run unit tests only"
    echo "  loki sandbox phase                              # Check phase, get testing tips"
    echo "  loki sandbox run 'npm test'                     # Run custom command"
    echo "  loki sandbox cleanup                            # Remove old worktrees"
}

#===============================================================================
# Main
#===============================================================================

main() {
    local command="${1:-help}"
    shift || true

    # Parse mode option
    local mode="auto"
    local args=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --docker-desktop) mode="docker-desktop"; shift ;;
            --docker) mode="docker"; shift ;;
            --worktree) mode="worktree"; shift ;;
            --auto) mode="auto"; shift ;;
            *) args+=("$1"); shift ;;
        esac
    done

    # Detect sandbox mode for commands that need it
    local sandbox_mode=""
    case "$command" in
        start|stop|status|prompt|shell|logs|run|serve|test|phase)
            sandbox_mode=$(detect_sandbox_mode "$mode") || exit 1
            ;;
    esac

    case "$command" in
        start)
            if [[ "$sandbox_mode" == "docker-desktop" ]]; then
                start_docker_desktop_sandbox ${args[@]+"${args[@]}"}
            elif [[ "$sandbox_mode" == "docker" ]]; then
                start_sandbox ${args[@]+"${args[@]}"}
            else
                start_worktree_sandbox ${args[@]+"${args[@]}"}
            fi
            ;;
        stop)
            if [[ "$sandbox_mode" == "docker-desktop" ]]; then
                stop_docker_desktop_sandbox
            elif [[ "$sandbox_mode" == "docker" ]]; then
                stop_sandbox
            else
                stop_worktree_sandbox
            fi
            ;;
        status)
            if [[ "$sandbox_mode" == "docker-desktop" ]]; then
                docker_desktop_sandbox_status
            elif [[ "$sandbox_mode" == "docker" ]]; then
                sandbox_status
            else
                worktree_sandbox_status
            fi
            ;;
        logs)
            if [[ "$sandbox_mode" == "docker-desktop" ]]; then
                docker_desktop_sandbox_logs ${args[@]+"${args[@]}"}
            else
                sandbox_logs ${args[@]+"${args[@]}"}
            fi
            ;;
        shell)
            if [[ "$sandbox_mode" == "docker-desktop" ]]; then
                docker_desktop_sandbox_shell
            else
                sandbox_shell
            fi
            ;;
        build)
            sandbox_build
            ;;
        prompt)
            if [[ "$sandbox_mode" == "docker-desktop" ]]; then
                docker_desktop_sandbox_prompt ${args[@]+"${args[@]}"}
            elif [[ "$sandbox_mode" == "docker" ]]; then
                sandbox_prompt ${args[@]+"${args[@]}"}
            else
                worktree_sandbox_prompt ${args[@]+"${args[@]}"}
            fi
            ;;
        run)
            if [[ "$sandbox_mode" == "docker-desktop" ]]; then
                docker_desktop_sandbox_run ${args[@]+"${args[@]}"}
            else
                sandbox_run ${args[@]+"${args[@]}"}
            fi
            ;;
        cleanup)
            cleanup_worktrees
            ;;
        serve)
            if [[ "$sandbox_mode" == "docker-desktop" ]]; then
                docker_desktop_sandbox_run "npm start 2>/dev/null || python3 -m http.server ${args[0]:-3000}"
            else
                sandbox_serve ${args[@]+"${args[@]}"}
            fi
            ;;
        test)
            if [[ "$sandbox_mode" == "docker-desktop" ]]; then
                docker_desktop_sandbox_run "npm test 2>/dev/null || python3 -m pytest 2>/dev/null || echo 'No test runner found'"
            else
                sandbox_test ${args[@]+"${args[@]}"}
            fi
            ;;
        phase)
            if [[ "$sandbox_mode" == "docker-desktop" ]]; then
                docker_desktop_sandbox_run "bash ${PROJECT_DIR}/autonomy/loki status"
            else
                sandbox_phase
            fi
            ;;
        expose)
            sandbox_expose ${args[@]+"${args[@]}"}
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
