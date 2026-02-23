# Autonomi Python SDK

Python SDK for the Loki Mode Control Plane API. Zero external dependencies -- uses only the Python standard library.

## Installation

```bash
pip install autonomi
```

## Quick Start

```python
from autonomi import AutonomiClient

client = AutonomiClient(base_url="http://localhost:57374", api_key="your-key")

# List projects
projects = client.list_projects()
for p in projects:
    print(p.name, p.status)

# Create a task
task = client.create_task(project_id="proj-1", title="Build login page")
print(task.id, task.status)
```

## Features

- **AutonomiClient** -- Full CRUD for projects, tasks, runs, and audit logs
- **TokenAuth** -- API key authentication
- **SessionManager** -- Session lifecycle management
- **TaskManager** -- Task queue operations
- **EventStream** -- Real-time event streaming

## Requirements

- Python 3.9+
- No external dependencies

## License

MIT
