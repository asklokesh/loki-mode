#!/usr/bin/env bash
# Loki Mode SessionStart Hook
# Loads memory context and initializes session state

set -euo pipefail

# Read input JSON from stdin
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))")
CWD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd',''))")

# Validate CWD is a safe path (no special characters that could break things)
if [[ ! "$CWD" =~ ^[a-zA-Z0-9/_.-]+$ ]]; then
    echo '{"continue": false, "systemMessage": "Invalid cwd path"}' >&2
    exit 1
fi

# Initialize .loki directory if needed
mkdir -p "$CWD/.loki/state" "$CWD/.loki/memory" "$CWD/.loki/logs"

# Load memory context using environment variables (safe from injection)
if [ -f "$CWD/.loki/memory/index.json" ]; then
    # Memory context is loaded for side effects (engine initialization)
    LOKI_CWD="$CWD" LOKI_MEMORY_PATH="$CWD/.loki/memory" python3 -c '
import json
import os
import sys

cwd = os.environ.get("LOKI_CWD", "")
memory_path = os.environ.get("LOKI_MEMORY_PATH", "")

sys.path.insert(0, cwd)
try:
    from memory.engine import MemoryEngine
    engine = MemoryEngine(memory_path)
    stats = engine.get_stats()
    print(json.dumps({"memories_loaded": stats}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
' 2>/dev/null || true
fi

# Escape special characters in SESSION_ID for JSON output
SAFE_SESSION_ID=$(echo "$SESSION_ID" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip())[1:-1])')

# Output session initialization info
cat << EOF
{
  "continue": true,
  "systemMessage": "Loki Mode initialized. Session: $SAFE_SESSION_ID. Memory context loaded."
}
EOF

exit 0
