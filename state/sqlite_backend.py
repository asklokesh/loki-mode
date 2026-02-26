"""SQLite state backend for Loki Mode.

Secondary storage layer that mirrors file-based state into SQLite
for queryable access. The file-based state in .loki/ remains primary.
SQLite is a read-optimized query layer, NOT the source of truth.

Usage:
    db = SqliteStateBackend(".loki/state.db")
    db.record_event("agent_started", {"agent_id": "arch_001", "phase": "understand"})
    events = db.query_events(agent_id="arch_001")
    db.record_message("task.completed", {"step_id": "step_001"}, sender="migration_planner")
    messages = db.query_messages(topic="task.*")
"""

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path


class SqliteStateBackend:
    """SQLite-backed queryable state for debugging and inspection."""

    def __init__(self, db_path: str = None):
        if db_path is None:
            db_path = os.path.join(
                os.environ.get("LOKI_DATA_DIR", os.path.expanduser("~/.loki")),
                "state.db"
            )
        self.db_path = db_path
        self._lock = threading.Lock()
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    data TEXT NOT NULL,
                    session_id TEXT,
                    agent_id TEXT,
                    migration_id TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
                CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);
                CREATE INDEX IF NOT EXISTS idx_events_migration ON events(migration_id);

                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    topic TEXT NOT NULL,
                    data TEXT NOT NULL,
                    sender TEXT,
                    cluster_id TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic);
                CREATE INDEX IF NOT EXISTS idx_messages_cluster ON messages(cluster_id);

                CREATE TABLE IF NOT EXISTS checkpoints (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    migration_id TEXT NOT NULL,
                    step_id TEXT NOT NULL,
                    git_sha TEXT,
                    metadata TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_checkpoints_migration ON checkpoints(migration_id);
            """)
        # Set secure file permissions (owner read/write only)
        try:
            os.chmod(self.db_path, 0o600)
        except OSError:
            pass

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=5)
        conn.row_factory = sqlite3.Row
        return conn

    def record_event(self, event_type: str, data: dict,
                     session_id: str = None, agent_id: str = None,
                     migration_id: str = None) -> int:
        """Record an event. Returns row ID."""
        with self._lock, self._connect() as conn:
            cursor = conn.execute(
                "INSERT INTO events (timestamp, event_type, data, session_id, agent_id, migration_id) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (datetime.now(timezone.utc).isoformat() + "Z", event_type,
                 json.dumps(data), session_id, agent_id, migration_id)
            )
            return cursor.lastrowid

    def query_events(self, event_type: str = None, agent_id: str = None,
                     migration_id: str = None, limit: int = 100) -> list[dict]:
        """Query events with optional filters."""
        conditions = []
        params = []
        if event_type:
            conditions.append("event_type = ?")
            params.append(event_type)
        if agent_id:
            conditions.append("agent_id = ?")
            params.append(agent_id)
        if migration_id:
            conditions.append("migration_id = ?")
            params.append(migration_id)

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM events {where} ORDER BY id DESC LIMIT ?",
                params + [limit]
            ).fetchall()
            return [dict(row) for row in rows]

    def record_message(self, topic: str, data: dict, sender: str = "",
                       cluster_id: str = None) -> int:
        """Record a pub/sub message. Returns row ID."""
        with self._lock, self._connect() as conn:
            cursor = conn.execute(
                "INSERT INTO messages (timestamp, topic, data, sender, cluster_id) "
                "VALUES (?, ?, ?, ?, ?)",
                (datetime.now(timezone.utc).isoformat() + "Z", topic,
                 json.dumps(data), sender, cluster_id)
            )
            return cursor.lastrowid

    def query_messages(self, topic: str = None, cluster_id: str = None,
                       limit: int = 100) -> list[dict]:
        """Query messages with optional filters. Supports wildcard topics."""
        conditions = []
        params = []
        if topic:
            if "*" in topic:
                conditions.append("topic GLOB ?")
                params.append(topic)
            else:
                conditions.append("topic = ?")
                params.append(topic)
        if cluster_id:
            conditions.append("cluster_id = ?")
            params.append(cluster_id)

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM messages {where} ORDER BY id DESC LIMIT ?",
                params + [limit]
            ).fetchall()
            return [dict(row) for row in rows]

    def record_checkpoint(self, migration_id: str, step_id: str,
                          git_sha: str = None, metadata: dict = None) -> int:
        """Record a migration checkpoint. Returns row ID."""
        with self._lock, self._connect() as conn:
            cursor = conn.execute(
                "INSERT INTO checkpoints (timestamp, migration_id, step_id, git_sha, metadata) "
                "VALUES (?, ?, ?, ?, ?)",
                (datetime.now(timezone.utc).isoformat() + "Z", migration_id,
                 step_id, git_sha, json.dumps(metadata or {}))
            )
            return cursor.lastrowid

    def query_checkpoints(self, migration_id: str = None,
                          limit: int = 100) -> list[dict]:
        """Query checkpoints with optional migration_id filter."""
        conditions = []
        params = []
        if migration_id:
            conditions.append("migration_id = ?")
            params.append(migration_id)

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM checkpoints {where} ORDER BY id DESC LIMIT ?",
                params + [limit]
            ).fetchall()
            return [dict(row) for row in rows]

    def get_db_path(self) -> str:
        """Return the path to the SQLite database file."""
        return self.db_path
