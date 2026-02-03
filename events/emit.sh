#!/bin/bash
# Loki Mode Event Emitter - Bash helper for emitting events
#
# Usage:
#   ./emit.sh <type> <source> <action> [key=value ...]
#
# Examples:
#   ./emit.sh session cli start provider=claude
#   ./emit.sh task runner complete task_id=task-001
#   ./emit.sh error hook failed error="Command blocked"
#
# Environment:
#   LOKI_DIR - Path to .loki directory (default: .loki)

set -uo pipefail

# Configuration
LOKI_DIR="${LOKI_DIR:-.loki}"
EVENTS_DIR="$LOKI_DIR/events/pending"

# Ensure directory exists
mkdir -p "$EVENTS_DIR"

# Arguments
TYPE="${1:-state}"
SOURCE="${2:-cli}"
ACTION="${3:-unknown}"
shift 3 2>/dev/null || true

# Generate event ID and timestamp
EVENT_ID=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

# Build payload JSON
PAYLOAD="{\"action\":\"$ACTION\""
for arg in "$@"; do
    key="${arg%%=*}"
    value="${arg#*=}"
    # Escape quotes in value
    value=$(echo "$value" | sed 's/"/\\"/g')
    PAYLOAD="$PAYLOAD,\"$key\":\"$value\""
done
PAYLOAD="$PAYLOAD}"

# Build full event JSON
EVENT=$(cat <<EOF
{
  "id": "$EVENT_ID",
  "type": "$TYPE",
  "source": "$SOURCE",
  "timestamp": "$TIMESTAMP",
  "payload": $PAYLOAD,
  "version": "1.0"
}
EOF
)

# Write event file
EVENT_FILE="$EVENTS_DIR/${TIMESTAMP//:/-}_$EVENT_ID.json"
echo "$EVENT" > "$EVENT_FILE"

# Output event ID
echo "$EVENT_ID"
