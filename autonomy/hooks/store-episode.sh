#!/usr/bin/env bash
# Loki Mode SessionEnd Hook - Episode Storage
# Stores session as episodic memory

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))")
CWD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd',''))")

# Store episode if memory system available
if [ -d "$CWD/memory" ]; then
    # Pass variables via environment to avoid command injection
    LOKI_CWD="$CWD" LOKI_SESSION_ID="$SESSION_ID" python3 << 'EOF'
import sys
import os

cwd = os.environ.get('LOKI_CWD', '')
session_id = os.environ.get('LOKI_SESSION_ID', '')

sys.path.insert(0, cwd)
try:
    from memory.engine import MemoryEngine
    from memory.schemas import EpisodeTrace
    from datetime import datetime, timezone
    import json

    engine = MemoryEngine(os.path.join(cwd, '.loki/memory'))

    # Create minimal episode from session
    episode = EpisodeTrace(
        id=session_id,
        task_id=f'session-{session_id}',
        timestamp=datetime.now(timezone.utc),
        duration_seconds=0,
        agent='loki-mode',
        phase='session',
        goal='Session completed',
        action_log=[],
        outcome='completed',
        errors_encountered=[],
        artifacts_produced=[],
        git_commit=None,
        tokens_used=0,
        files_read=[],
        files_modified=[]
    )
    engine.store_episode(episode)
    print(f'Episode stored: {session_id}')
except Exception as e:
    print(f'Episode storage failed: {e}', file=sys.stderr)
EOF
fi

exit 0
