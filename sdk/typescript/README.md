# @autonomi/sdk

TypeScript/Node.js SDK for the Autonomi Control Plane API. Zero runtime dependencies.

## Installation

```bash
npm install @autonomi/sdk
```

## Quick Start

```typescript
import { AutonomiClient } from '@autonomi/sdk';

const client = new AutonomiClient({
  baseUrl: 'http://localhost:57374',
  token: 'loki_xxx',
});

// List projects
const projects = await client.listProjects();
for (const p of projects) {
  console.log(p.name, p.status);
}

// Create a task
const task = await client.createTask('proj-1', { title: 'Build login page' });
console.log(task.id, task.status);
```

## Features

- **AutonomiClient** -- Full CRUD for projects, tasks, runs, and audit logs
- **Tenant management** -- Multi-tenant API key provisioning
- **Audit trail** -- Tamper-evident audit log queries and verification
- **Type-safe** -- Full TypeScript type definitions included

## Requirements

- Node.js 18+
- No runtime dependencies

## License

MIT
