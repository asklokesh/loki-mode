#!/bin/bash
# Sync Loki Loop tasks to Vibe Kanban SQLite database
# Works on macOS and Linux, auto-detects project name from current directory

set -uo pipefail

LOKI_DIR=".loki"
PROJECT_NAME="$(basename "$(pwd)")"
PROJECT_PATH="$(pwd)"

# Detect Vibe Kanban database location
if [[ "$OSTYPE" == "darwin"* ]]; then
    DB_PATH="$HOME/Library/Application Support/ai.bloop.vibe-kanban/db.sqlite"
else
    # Linux: check common locations
    DB_PATH="${XDG_DATA_HOME:-$HOME/.local/share}/ai.bloop.vibe-kanban/db.sqlite"
    if [ ! -f "$DB_PATH" ]; then
        DB_PATH="$HOME/.config/ai.bloop.vibe-kanban/db.sqlite"
    fi
fi

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# Validate prerequisites
if [ ! -d "$LOKI_DIR" ]; then
    log_error "No .loki directory found. Run Loki Loop first."
    exit 1
fi

if [ ! -f "$DB_PATH" ]; then
    log_error "Vibe Kanban database not found at: $DB_PATH"
    log_error "Make sure Vibe Kanban has been run at least once."
    exit 1
fi

if ! command -v sqlite3 &> /dev/null; then
    log_error "sqlite3 is required but not installed."
    exit 1
fi

log_info "Project: $PROJECT_NAME"
log_info "Path: $PROJECT_PATH"
log_info "Database: $DB_PATH"

# Get current phase
CURRENT_PHASE="UNKNOWN"
if [ -f "$LOKI_DIR/state/orchestrator.json" ]; then
    CURRENT_PHASE=$(python3 -c "import json; print(json.load(open('$LOKI_DIR/state/orchestrator.json')).get('currentPhase', 'UNKNOWN'))" 2>/dev/null || echo "UNKNOWN")
fi

# Get or create project, return project ID as hex
get_or_create_project() {
    local project_id
    project_id=$(sqlite3 "$DB_PATH" "SELECT hex(id) FROM projects WHERE name='$PROJECT_NAME' LIMIT 1;" 2>/dev/null)

    if [ -z "$project_id" ]; then
        log_info "Creating new project: $PROJECT_NAME"
        sqlite3 "$DB_PATH" "INSERT INTO projects (id, name, default_agent_working_dir, created_at, updated_at) VALUES (randomblob(16), '$PROJECT_NAME', '$PROJECT_PATH', datetime('now', 'subsec'), datetime('now', 'subsec'));"
        project_id=$(sqlite3 "$DB_PATH" "SELECT hex(id) FROM projects WHERE name='$PROJECT_NAME' LIMIT 1;")
    fi

    echo "$project_id"
}

# Main sync function
sync_tasks() {
    local project_id="$1"

    # Clear existing Loki-synced tasks for this project
    sqlite3 "$DB_PATH" "DELETE FROM tasks WHERE project_id = X'$project_id' AND title LIKE '[Loki]%';"

    local count=0

    # Process each queue file
    for queue in pending in-progress completed failed dead-letter; do
        local queue_file="$LOKI_DIR/queue/${queue}.json"
        [ ! -f "$queue_file" ] && continue

        # Parse and insert tasks
        python3 << EOF
import json
import subprocess
import sys

def escape_sql(s):
    """Escape single quotes for SQL."""
    if s is None:
        return ""
    return str(s).replace("'", "''")

def map_status(queue_status):
    mapping = {
        "pending": "todo",
        "not-started": "todo",
        "in-progress": "inprogress",
        "claimed": "inprogress",
        "completed": "done",
        "done": "done",
        "failed": "cancelled",
        "dead-letter": "cancelled"
    }
    return mapping.get(queue_status, "todo")

def map_priority(p):
    if p >= 8: return "HIGH"
    elif p >= 5: return "MEDIUM"
    return "LOW"

try:
    with open("$queue_file") as f:
        content = f.read().strip()
        if not content or content == "[]":
            sys.exit(0)
        tasks = json.loads(content)
except (json.JSONDecodeError, FileNotFoundError):
    sys.exit(0)

db_path = "$DB_PATH"
project_id = "$project_id"
current_phase = "$CURRENT_PHASE"
queue_status = "$queue"

for task in tasks:
    task_id = task.get('id', 'unknown')
    payload = task.get('payload', {})

    # Extract title
    if isinstance(payload, dict):
        title = payload.get('action', payload.get('description', payload.get('title', 'Task')))
    else:
        title = str(payload)[:50] if payload else 'Task'

    # Build description
    agent_type = task.get('type', 'unknown')
    priority = task.get('priority', 5)
    desc_parts = [
        f"Phase: {current_phase}",
        f"Agent: {agent_type}",
        f"Priority: {map_priority(priority)}",
        f"Loki ID: {task_id}"
    ]
    if isinstance(payload, dict) and 'description' in payload:
        desc_parts.append(f"\\n{payload['description']}")
    description = "\\n".join(desc_parts)

    # Map status
    status = map_status(queue_status)

    # Escape for SQL
    title_esc = escape_sql(f"[Loki] {title}")
    desc_esc = escape_sql(description)

    # Insert task
    sql = f"""INSERT INTO tasks (id, project_id, title, description, status, created_at, updated_at)
              VALUES (randomblob(16), X'{project_id}', '{title_esc}', '{desc_esc}', '{status}',
              datetime('now', 'subsec'), datetime('now', 'subsec'));"""

    subprocess.run(["sqlite3", db_path, sql], check=True, capture_output=True)
    print(f"INSERTED:{task_id}")

EOF

        # Count inserted tasks
        local inserted
        inserted=$(python3 << EOF
import json
try:
    with open("$queue_file") as f:
        tasks = json.loads(f.read().strip() or "[]")
        print(len(tasks))
except:
    print(0)
EOF
)
        if [ "$inserted" -gt 0 ]; then
            log_info "  $queue: $inserted tasks"
            count=$((count + inserted))
        fi
    done

    echo "$count"
}

# Execute
PROJECT_ID=$(get_or_create_project)
log_info "Project ID: $PROJECT_ID"
log_info "Phase: $CURRENT_PHASE"

TOTAL=$(sync_tasks "$PROJECT_ID")
log_info "Synced $TOTAL tasks to Vibe Kanban"
