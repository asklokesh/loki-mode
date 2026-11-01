from dataclasses import dataclass
from datetime import date
from typing import Optional


@dataclass
class Task:
    id: int
    title: str
    done: bool = False
    due: Optional[date] = None


def sort_key(task: Task):
    """Pending first, then by due date (undated last), then by id."""
    return (task.done, task.due is None, task.due or date.max, task.id)
