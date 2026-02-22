# Loki Mode v5.51.0 -- SDK Guide

Official Python and TypeScript SDKs for the Autonomi Control Plane API. Both SDKs have zero external dependencies -- they use only standard library features.

---

## Python SDK

### Installation

```bash
pip install autonomi
```

Or install from source:

```bash
cd sdk/python
pip install -e .
```

**Requirements:** Python 3.9 or later. No external dependencies.

### Quick Start

```python
from autonomi import AutonomiClient

# Create a client
client = AutonomiClient(
    base_url="http://localhost:57374",
    token="loki_your_token_here",
)

# Check API status
status = client.get_status()
print(f"API version: {status.get('version')}")

# List projects
projects = client.list_projects()
for p in projects:
    print(f"  {p.id}: {p.name} ({p.status})")
```

### Client Methods

#### Status

```python
client.get_status() -> Dict[str, Any]
```

Returns the API server status including version, uptime, and feature flags.

#### Projects

```python
client.list_projects() -> List[Project]
client.get_project(project_id: str) -> Project
client.create_project(name: str, description: Optional[str] = None) -> Project
```

`Project` fields: `id`, `name`, `description`, `status`, `tenant_id`, `created_at`, `updated_at`

#### Tenants

```python
client.list_tenants() -> List[Tenant]
client.create_tenant(name: str, description: Optional[str] = None) -> Tenant
```

`Tenant` fields: `id`, `name`, `slug`, `description`, `created_at`

#### Runs

```python
client.list_runs(project_id: Optional[str] = None, status: Optional[str] = None) -> List[Run]
client.get_run(run_id: str) -> Run
client.cancel_run(run_id: str) -> Run
client.replay_run(run_id: str) -> Run
client.get_run_timeline(run_id: str) -> List[RunEvent]
```

`Run` fields: `id`, `project_id`, `status`, `trigger`, `config`, `started_at`, `ended_at`

`RunEvent` fields: `id`, `run_id`, `event_type`, `phase`, `details`, `timestamp`

#### API Keys

```python
client.list_api_keys() -> List[ApiKey]
client.create_api_key(name: str, role: str = "viewer") -> Dict[str, Any]
client.rotate_api_key(identifier: str, grace_period_hours: int = 24) -> Dict[str, Any]
```

`ApiKey` fields: `id`, `name`, `scopes`, `role`, `created_at`, `expires_at`, `last_used`

**Note:** `create_api_key()` returns a dict that includes the raw token. This is the only time the token is returned in full -- store it securely.

#### Audit

```python
client.query_audit(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    action: Optional[str] = None,
    limit: int = 100,
) -> List[AuditEntry]
```

`AuditEntry` fields: `timestamp`, `action`, `resource_type`, `resource_id`, `user_id`, `success`

### Helper Classes

#### SessionManager

```python
from autonomi import AutonomiClient, SessionManager

client = AutonomiClient(base_url="http://localhost:57374", token="loki_xxx")
sessions = SessionManager(client)

# List sessions for a project
project_sessions = sessions.list_sessions("proj-1")

# Get session details
session = sessions.get_session("session-id")
```

#### TaskManager

```python
from autonomi import AutonomiClient, TaskManager

client = AutonomiClient(base_url="http://localhost:57374", token="loki_xxx")
tasks = TaskManager(client)

# List tasks
all_tasks = tasks.list_tasks(project_id="proj-1", status="pending")

# Create a task
task = tasks.create_task(
    project_id="proj-1",
    title="Implement auth module",
    description="Add JWT-based authentication",
    priority="high",
)

# Update task status
tasks.update_task(task.id, status="in_progress")
```

#### EventStream

```python
from autonomi import AutonomiClient, EventStream
import time

client = AutonomiClient(base_url="http://localhost:57374", token="loki_xxx")
events = EventStream(client)

# Poll for run events
last_timestamp = None
while True:
    new_events = events.poll_events("run-1", since=last_timestamp)
    for event in new_events:
        print(f"[{event.event_type}] {event.phase}: {event.details}")
        last_timestamp = event.timestamp
    time.sleep(2)
```

### Error Handling

```python
from autonomi import (
    AutonomiClient,
    AutonomiError,
    AuthenticationError,
    PermissionDeniedError,
    NotFoundError,
)

client = AutonomiClient(base_url="http://localhost:57374", token="loki_xxx")

try:
    project = client.get_project("nonexistent")
except NotFoundError as e:
    print(f"Project not found: {e}")
    print(f"Status code: {e.status_code}")  # 404
except AuthenticationError as e:
    print(f"Auth failed: {e}")  # Token invalid or expired
except PermissionDeniedError as e:
    print(f"Access denied: {e}")  # Insufficient role
except AutonomiError as e:
    print(f"API error: {e}")
    print(f"Status code: {e.status_code}")
    print(f"Response body: {e.response_body}")
```

Error hierarchy:
```
AutonomiError (base)
  +-- AuthenticationError (401)
  +-- PermissionDeniedError (403)
  +-- NotFoundError (404)
```

---

## TypeScript SDK

### Installation

```bash
npm install @autonomi/sdk
```

Or use from source:

```bash
cd sdk/typescript
npm link
```

**Requirements:** Node.js 18 or later (uses built-in `fetch`). No external dependencies.

### Quick Start

```typescript
import { AutonomiClient } from '@autonomi/sdk';

const client = new AutonomiClient({
  baseUrl: 'http://localhost:57374',
  token: 'loki_your_token_here',
});

// Check API status
const status = await client.getStatus();
console.log('API version:', status.version);

// List projects
const projects = await client.listProjects();
for (const p of projects) {
  console.log(`  ${p.id}: ${p.name} (${p.status})`);
}
```

### Client Methods

#### Status

```typescript
client.getStatus(): Promise<Record<string, unknown>>
```

#### Projects

```typescript
client.listProjects(): Promise<Project[]>
client.getProject(projectId: number): Promise<Project>
client.createProject(name: string, description?: string): Promise<Project>
```

#### Tasks

```typescript
client.listTasks(projectId?: number, status?: string): Promise<Task[]>
client.getTask(taskId: number): Promise<Task>
client.createTask(projectId: number, title: string, description?: string): Promise<Task>
```

#### Runs

```typescript
client.listRuns(projectId?: number, status?: string): Promise<Run[]>
client.getRun(runId: number): Promise<Run>
client.cancelRun(runId: number): Promise<Run>
client.replayRun(runId: number): Promise<Run>
client.getRunTimeline(runId: number): Promise<RunEvent[]>
```

#### Tenants

```typescript
client.listTenants(): Promise<Tenant[]>
client.getTenant(tenantId: number): Promise<Tenant>
client.createTenant(name: string, description?: string): Promise<Tenant>
client.deleteTenant(tenantId: number): Promise<void>
```

#### API Keys

```typescript
client.listApiKeys(): Promise<ApiKey[]>
client.createApiKey(name: string, role?: string): Promise<ApiKey & { token: string }>
client.rotateApiKey(identifier: string, gracePeriodHours?: number): Promise<Record<string, unknown>>
client.deleteApiKey(identifier: string): Promise<void>
```

#### Audit

```typescript
client.queryAudit(params?: AuditQueryParams): Promise<AuditEntry[]>
client.verifyAudit(): Promise<AuditVerifyResult>
```

### TypeScript Interfaces

```typescript
interface Project {
  id: number;
  name: string;
  description?: string;
  status: string;
  tenant_id?: number;
  created_at: string;
  updated_at: string;
}

interface Task {
  id: number;
  project_id: number;
  title: string;
  description?: string;
  status: string;
  priority: string;
}

interface Run {
  id: number;
  project_id: number;
  status: string;
  trigger: string;
  config?: Record<string, unknown>;
  started_at: string;
  ended_at?: string;
}

interface RunEvent {
  id: number;
  run_id: number;
  event_type: string;
  phase?: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

interface Tenant {
  id: number;
  name: string;
  slug: string;
  description?: string;
  created_at: string;
}

interface ApiKey {
  id: string;
  name: string;
  scopes: string[];
  role?: string;
  created_at: string;
  expires_at?: string;
  last_used?: string;
}

interface AuditEntry {
  timestamp: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  user_id?: string;
  success: boolean;
}

interface AuditQueryParams {
  start_date?: string;
  end_date?: string;
  action?: string;
  limit?: number;
}

interface AuditVerifyResult {
  valid: boolean;
  entries_checked: number;
}

interface ClientOptions {
  baseUrl: string;
  token?: string;
  timeout?: number;  // milliseconds, default 30000
}
```

### Error Handling

```typescript
import {
  AutonomiClient,
  AutonomiError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
} from '@autonomi/sdk';

const client = new AutonomiClient({
  baseUrl: 'http://localhost:57374',
  token: 'loki_xxx',
});

try {
  const project = await client.getProject(999);
} catch (err) {
  if (err instanceof NotFoundError) {
    console.log('Project not found:', err.message);
  } else if (err instanceof AuthenticationError) {
    console.log('Auth failed:', err.message);
  } else if (err instanceof ForbiddenError) {
    console.log('Access denied:', err.message);
  } else if (err instanceof AutonomiError) {
    console.log('API error:', err.message);
    console.log('Status code:', err.statusCode);
    console.log('Response:', err.responseBody);
  }
}
```

Error hierarchy:
```
AutonomiError (base)
  +-- AuthenticationError (401)
  +-- ForbiddenError (403)
  +-- NotFoundError (404)
```

---

## Common Patterns

### Pagination

Both SDKs support pagination for list endpoints:

```python
# Python
entries = client.query_audit(limit=50)  # First 50 entries
```

```typescript
// TypeScript
const entries = await client.queryAudit({ limit: 50 });
```

### Filtering

Filter runs by project and status:

```python
# Python
active_runs = client.list_runs(project_id="proj-1", status="running")
```

```typescript
// TypeScript
const activeRuns = await client.listRuns(1, 'running');
```

### Webhook Processing

Process incoming webhooks and update the Control Plane:

```python
# Python -- Flask webhook handler example
from flask import Flask, request
from autonomi import AutonomiClient

app = Flask(__name__)
client = AutonomiClient(base_url="http://localhost:57374", token="loki_xxx")

@app.route("/webhook", methods=["POST"])
def handle_webhook():
    payload = request.json
    event_type = payload.get("type")

    if event_type == "task_completed":
        # Update task status in the Control Plane
        from autonomi import TaskManager
        tasks = TaskManager(client)
        tasks.update_task(payload["task_id"], status="completed")

    return {"ok": True}
```

### API Key Rotation

Automate key rotation with grace periods:

```python
# Python
# Rotate key, old key valid for 24 more hours
result = client.rotate_api_key("ci-pipeline", grace_period_hours=24)
new_token = result.get("token")
# Store new_token securely, update CI secrets
```

```typescript
// TypeScript
const result = await client.rotateApiKey('ci-pipeline', 24);
// Store result.token securely
```

### Audit Chain Verification

Periodically verify audit integrity:

```python
# Python
entries = client.query_audit(start_date="2026-02-01", limit=1000)
print(f"Audit entries: {len(entries)}")
for entry in entries:
    if not entry.success:
        print(f"  FAILED: {entry.action} on {entry.resource_type}/{entry.resource_id}")
```

```typescript
// TypeScript
const result = await client.verifyAudit();
if (!result.valid) {
  console.log('AUDIT CHAIN COMPROMISED');
} else {
  console.log(`Chain valid: ${result.entries_checked} entries verified`);
}
```

---

## API Reference Summary

| Category | Python Method | TypeScript Method | HTTP |
|----------|--------------|-------------------|------|
| Status | `get_status()` | `getStatus()` | `GET /api/status` |
| Projects | `list_projects()` | `listProjects()` | `GET /api/projects` |
| Projects | `get_project(id)` | `getProject(id)` | `GET /api/projects/:id` |
| Projects | `create_project(name)` | `createProject(name)` | `POST /api/projects` |
| Tenants | `list_tenants()` | `listTenants()` | `GET /api/tenants` |
| Tenants | `create_tenant(name)` | `createTenant(name)` | `POST /api/tenants` |
| Tenants | -- | `deleteTenant(id)` | `DELETE /api/tenants/:id` |
| Runs | `list_runs()` | `listRuns()` | `GET /api/runs` |
| Runs | `get_run(id)` | `getRun(id)` | `GET /api/runs/:id` |
| Runs | `cancel_run(id)` | `cancelRun(id)` | `POST /api/runs/:id/cancel` |
| Runs | `replay_run(id)` | `replayRun(id)` | `POST /api/runs/:id/replay` |
| Runs | `get_run_timeline(id)` | `getRunTimeline(id)` | `GET /api/runs/:id/timeline` |
| Keys | `list_api_keys()` | `listApiKeys()` | `GET /api/keys` |
| Keys | `create_api_key(name)` | `createApiKey(name)` | `POST /api/keys` |
| Keys | `rotate_api_key(id)` | `rotateApiKey(id)` | `POST /api/keys/:id/rotate` |
| Keys | -- | `deleteApiKey(id)` | `DELETE /api/keys/:id` |
| Audit | `query_audit()` | `queryAudit()` | `GET /api/audit` |
| Audit | -- | `verifyAudit()` | `GET /api/audit/verify` |
