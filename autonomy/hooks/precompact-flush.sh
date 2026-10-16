#!/usr/bin/env bash
# Loki Mode PreCompact Hook - milestone flush
# Writes a state snapshot to .loki/state/precompact-snapshot.json before the
# context is compacted. Atomic (tmp + rename). Never fails the session: any
# error prints a stderr note and exits 0.

INPUT=$(cat 2>/dev/null || true)

LOKI_HOOK_INPUT="$INPUT" LOKI_HOOK_PWD="$PWD" python3 - <<'PY' || echo "precompact-flush: snapshot failed (ignored)" >&2
import json, os, sys, tempfile
from datetime import datetime, timezone

try:
    data = json.loads(os.environ.get("LOKI_HOOK_INPUT") or "{}")
    if not isinstance(data, dict):
        data = {}
except Exception:
    data = {}

cwd = data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.environ["LOKI_HOOK_PWD"]
state_dir = os.path.join(cwd, ".loki", "state")


def load(name):
    try:
        with open(os.path.join(state_dir, name)) as f:
            return json.load(f)
    except Exception:
        return None


snap = {
    "flushed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "event": "PreCompact",
    "session_id": data.get("session_id", ""),
    "trigger": data.get("trigger", ""),
    "orchestrator": load("orchestrator.json"),
    "completion": load("completion.json"),
}

try:
    os.makedirs(state_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".precompact-snapshot.", dir=state_dir)
    with os.fdopen(fd, "w") as f:
        json.dump(snap, f, indent=2)
        f.write("\n")
    os.replace(tmp, os.path.join(state_dir, "precompact-snapshot.json"))
except Exception as e:
    print("precompact-flush: write failed: %s (ignored)" % e, file=sys.stderr)
PY
exit 0
