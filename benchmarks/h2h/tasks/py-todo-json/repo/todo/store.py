import json
from datetime import date
from pathlib import Path

from .models import Task


def load(path: str) -> list[Task]:
    p = Path(path)
    if not p.exists():
        return []
    raw = json.loads(p.read_text())
    return [
        Task(
            id=item["id"],
            title=item["title"],
            done=item.get("done", False),
            due=date.fromisoformat(item["due"]) if item.get("due") else None,
        )
        for item in raw
    ]
