# loki-mode-sdk

Python SDK for [Loki Mode](https://github.com/asklokesh/loki-mode), the autonomous multi-agent development platform.

## Install

```bash
pip install loki-mode-sdk
```

## Quick Start

```python
from loki_mode_sdk import Client

client = Client(base_url="http://localhost:57374")

# Check dashboard status
status = client.get_status()
print(status)

# List projects
projects = client.list_projects()
for p in projects:
    print(f"{p.id}: {p.name} ({p.status})")
```

## API Reference

The SDK wraps the Loki Mode Dashboard API (default port 57374).

### Client Methods

- `client.get_status()` - Dashboard status and version
- `client.list_projects()` - List all projects
- `client.create_project(name)` - Create a new project
- `client.get_project(id)` - Get project details
- `client.list_runs(project_id)` - List runs
- `client.cancel_run(run_id)` - Cancel a running execution
- `client.query_audit()` - Query audit trail
- `client.create_api_key(name)` - Create API key
- `client.rotate_api_key(key_id)` - Rotate API key

## Requirements

- Python 3.10+
- Running Loki Mode instance (`npm install -g loki-mode`)

## License

Business Source License 1.1 -- see [LICENSE](../../LICENSE)
