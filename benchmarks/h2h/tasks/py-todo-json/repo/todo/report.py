from .models import Task, sort_key


def render_text(tasks: list[Task]) -> str:
    lines = []
    for t in sorted(tasks, key=sort_key):
        box = "[x]" if t.done else "[ ]"
        due = f" (due {t.due.isoformat()})" if t.due else ""
        lines.append(f"{box} {t.id}: {t.title}{due}")
    return "\n".join(lines)
