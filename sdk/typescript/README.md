# loki-mode-sdk

TypeScript/JavaScript SDK for [Loki Mode](https://github.com/asklokesh/loki-mode), the autonomous multi-agent development platform.

## Install

```bash
npm install loki-mode-sdk
```

## Quick Start

```typescript
import { AutonomiClient } from 'loki-mode-sdk';

const client = new AutonomiClient({
  baseUrl: 'http://localhost:57374',
  token: 'loki_xxx',
});

// Check dashboard health
const status = await client.getStatus();
console.log(status);

// List projects
const projects = await client.listProjects();
for (const p of projects) {
  console.log(p.name, p.status);
}
```

## API Reference

The SDK wraps the Loki Mode Dashboard API (default port 57374).

### Client Methods

- `client.getStatus()` - Dashboard status and version
- `client.listProjects()` - List all projects
- `client.createProject(name)` - Create a new project
- `client.getProject(id)` - Get project details
- `client.listRuns(projectId)` - List runs
- `client.cancelRun(runId)` - Cancel a running execution
- `client.queryAudit()` - Query audit trail
- `client.createApiKey(name)` - Create API key
- `client.rotateApiKey(keyId)` - Rotate API key

## Requirements

- Node.js 18+
- Running Loki Mode instance (`npm install -g loki-mode`)

## License

Business Source License 1.1 -- see [LICENSE](../../LICENSE)
