#!/bin/bash
# Real-time sync watcher for Loki Loop -> Vibe Kanban
# Watches .loki/queue/ for changes and automatically exports tasks

set -uo pipefail

LOKI_DIR=".loki"
QUEUE_DIR="$LOKI_DIR/queue"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPORT_SCRIPT="$SCRIPT_DIR/sync-to-vibe-kanban.sh"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_sync() { echo -e "${BLUE}[SYNC]${NC} $*"; }

# Check prerequisites
if [ ! -d "$LOKI_DIR" ]; then
    log_warn "No .loki directory found. Run Loki Loop first."
    exit 1
fi

if [ ! -f "$EXPORT_SCRIPT" ]; then
    log_warn "Export script not found at: $EXPORT_SCRIPT"
    exit 1
fi

if [ ! -d "$QUEUE_DIR" ]; then
    log_warn "Queue directory not found. Waiting for Loki Loop to create it..."
    mkdir -p "$QUEUE_DIR"
fi

# Detect file watcher command
if command -v fswatch &> /dev/null; then
    WATCHER="fswatch"
    log_info "Using fswatch for file monitoring"
elif command -v inotifywait &> /dev/null; then
    WATCHER="inotifywait"
    log_info "Using inotifywait for file monitoring"
else
    log_warn "No file watcher found (fswatch or inotifywait)"
    log_warn "Falling back to polling mode (checks every 5 seconds)"
    WATCHER="poll"
fi

log_info "Starting Vibe Kanban sync watcher..."
log_info "Watching: $QUEUE_DIR"
log_info "Press Ctrl+C to stop"
echo ""

# Initial export
log_sync "Running initial export..."
if ! "$EXPORT_SCRIPT"; then
    log_warn "Initial export failed. Check export script and permissions."
fi
echo ""

# Watch loop
case "$WATCHER" in
    fswatch)
        # macOS/BSD
        fswatch -o "$QUEUE_DIR" | while read -r num; do
            log_sync "Queue changed, exporting tasks..."
            if ! "$EXPORT_SCRIPT"; then
                log_warn "Export failed. Check export script and permissions."
            fi
            echo ""
        done
        ;;

    inotifywait)
        # Linux
        while true; do
            inotifywait -e close_write,create,delete "$QUEUE_DIR" 2>/dev/null
            log_sync "Queue changed, exporting tasks..."
            if ! "$EXPORT_SCRIPT"; then
                log_warn "Export failed. Check export script and permissions."
            fi
            echo ""
            # Brief delay to avoid duplicate triggers
            sleep 2
        done
        ;;

    poll)
        # Fallback polling mode
        LAST_HASH=""
        while true; do
            # Calculate hash of all queue files
            if [ -d "$QUEUE_DIR" ]; then
                CURRENT_HASH=$(find "$QUEUE_DIR" -type f -name "*.json" -print0 2>/dev/null | xargs -0 md5sum 2>/dev/null | md5sum)

                if [ "$CURRENT_HASH" != "$LAST_HASH" ] && [ -n "$LAST_HASH" ]; then
                    log_sync "Queue changed, exporting tasks..."
                    if ! "$EXPORT_SCRIPT"; then
                        log_warn "Export failed. Check export script and permissions."
                    fi
                    echo ""
                fi

                LAST_HASH="$CURRENT_HASH"
            fi

            sleep 5
        done
        ;;
esac
