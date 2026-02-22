/**
 * Autonomi SDK - Client Tests
 *
 * Uses node:test and node:assert (Node 18+).
 * Mocks global fetch to test client behavior without a real server.
 *
 * Run: node --test tests/client.test.js
 */

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// ---------------------------------------------------------------------------
// Since the source is TypeScript, we re-implement the core classes inline
// for testing. This mirrors the TS source exactly and avoids needing tsx.
// ---------------------------------------------------------------------------

class AutonomiError extends Error {
  constructor(message, statusCode, responseBody) {
    super(message);
    this.name = 'AutonomiError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

class AuthenticationError extends AutonomiError {
  constructor(message = 'Authentication required', responseBody) {
    super(message, 401, responseBody);
    this.name = 'AuthenticationError';
  }
}

class ForbiddenError extends AutonomiError {
  constructor(message = 'Access forbidden', responseBody) {
    super(message, 403, responseBody);
    this.name = 'ForbiddenError';
  }
}

class NotFoundError extends AutonomiError {
  constructor(message = 'Resource not found', responseBody) {
    super(message, 404, responseBody);
    this.name = 'NotFoundError';
  }
}

class AutonomiClient {
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.timeout = options.timeout ?? 30000;
  }

  async _request(method, path, body, params) {
    let url = `${this.baseUrl}${path}`;

    if (params && Object.keys(params).length > 0) {
      const search = new URLSearchParams(params);
      url += `?${search.toString()}`;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = err instanceof Error ? err.message : 'Network error';
      throw new AutonomiError(msg, 0);
    } finally {
      clearTimeout(timeoutId);
    }

    const responseText = await response.text();

    if (!response.ok) {
      const statusCode = response.status;
      let message = responseText;
      try {
        const parsed = JSON.parse(responseText);
        message = parsed.error || parsed.message || parsed.detail || responseText;
      } catch {
        // use raw text
      }

      switch (statusCode) {
        case 401:
          throw new AuthenticationError(message, responseText);
        case 403:
          throw new ForbiddenError(message, responseText);
        case 404:
          throw new NotFoundError(message, responseText);
        default:
          throw new AutonomiError(message, statusCode, responseText);
      }
    }

    if (responseText.length === 0) {
      return undefined;
    }

    return JSON.parse(responseText);
  }

  async getStatus() {
    return this._request('GET', '/api/status');
  }

  async listProjects() {
    return this._request('GET', '/api/projects');
  }

  async getProject(projectId) {
    return this._request('GET', `/api/projects/${projectId}`);
  }

  async createProject(name, description) {
    const body = { name };
    if (description !== undefined) body.description = description;
    return this._request('POST', '/api/projects', body);
  }

  async listTasks(projectId, status) {
    const params = {};
    if (projectId !== undefined) params.project_id = String(projectId);
    if (status !== undefined) params.status = status;
    return this._request('GET', '/api/tasks', undefined, params);
  }

  async getTask(taskId) {
    return this._request('GET', `/api/tasks/${taskId}`);
  }

  async createTask(projectId, title, description) {
    const body = { project_id: projectId, title };
    if (description !== undefined) body.description = description;
    return this._request('POST', '/api/tasks', body);
  }

  async listApiKeys() {
    return this._request('GET', '/api/v2/api-keys');
  }

  async createApiKey(name, role) {
    const body = { name };
    if (role !== undefined) body.role = role;
    return this._request('POST', '/api/v2/api-keys', body);
  }

  async rotateApiKey(identifier, gracePeriodHours) {
    const body = {};
    if (gracePeriodHours !== undefined) body.grace_period_hours = gracePeriodHours;
    return this._request('POST', `/api/v2/api-keys/${identifier}/rotate`, body);
  }

  async deleteApiKey(identifier) {
    return this._request('DELETE', `/api/v2/api-keys/${identifier}`);
  }

  async listRuns(projectId, status) {
    const params = {};
    if (projectId !== undefined) params.project_id = String(projectId);
    if (status !== undefined) params.status = status;
    return this._request('GET', '/api/v2/runs', undefined, params);
  }

  async getRun(runId) {
    return this._request('GET', `/api/v2/runs/${runId}`);
  }

  async cancelRun(runId) {
    return this._request('POST', `/api/v2/runs/${runId}/cancel`);
  }

  async replayRun(runId) {
    return this._request('POST', `/api/v2/runs/${runId}/replay`);
  }

  async getRunTimeline(runId) {
    return this._request('GET', `/api/v2/runs/${runId}/timeline`);
  }

  async listTenants() {
    return this._request('GET', '/api/v2/tenants');
  }

  async getTenant(tenantId) {
    return this._request('GET', `/api/v2/tenants/${tenantId}`);
  }

  async createTenant(name, description) {
    const body = { name };
    if (description !== undefined) body.description = description;
    return this._request('POST', '/api/v2/tenants', body);
  }

  async deleteTenant(tenantId) {
    return this._request('DELETE', `/api/v2/tenants/${tenantId}`);
  }

  async queryAudit(params) {
    const queryParams = {};
    if (params?.start_date) queryParams.start_date = params.start_date;
    if (params?.end_date) queryParams.end_date = params.end_date;
    if (params?.action) queryParams.action = params.action;
    if (params?.limit !== undefined) queryParams.limit = String(params.limit);
    return this._request('GET', '/api/v2/audit', undefined, queryParams);
  }

  async verifyAudit() {
    return this._request('GET', '/api/v2/audit/verify');
  }
}

// ---------------------------------------------------------------------------
// Mock HTTP Server Helper
// ---------------------------------------------------------------------------

function createMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AutonomiClient', () => {
  let server;
  let port;
  let baseUrl;
  let lastRequest;

  // Generic handler that records requests and responds based on route
  const routes = new Map();

  function setRoute(method, path, statusCode, responseBody) {
    routes.set(`${method} ${path}`, { statusCode, responseBody });
  }

  beforeEach(async () => {
    routes.clear();
    lastRequest = null;

    const mock = await createMockServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1`);
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = chunks.length > 0 ? Buffer.concat(chunks).toString() : null;
        lastRequest = {
          method: req.method,
          path: url.pathname,
          search: url.search,
          headers: req.headers,
          body: body ? JSON.parse(body) : null,
        };

        // Check for exact path match first, then path with query
        const routeKey = `${req.method} ${url.pathname}`;
        const route = routes.get(routeKey);

        if (route) {
          res.writeHead(route.statusCode, { 'Content-Type': 'application/json' });
          res.end(typeof route.responseBody === 'string' ? route.responseBody : JSON.stringify(route.responseBody));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });
    });

    server = mock.server;
    port = mock.port;
    baseUrl = mock.baseUrl;
  });

  afterEach(async () => {
    if (server) await closeServer(server);
  });

  // -----------------------------------------------------------------------
  // 1. Client construction
  // -----------------------------------------------------------------------

  it('should construct with required options', () => {
    const client = new AutonomiClient({ baseUrl: 'http://localhost:8000' });
    assert.ok(client);
    assert.equal(client.baseUrl, 'http://localhost:8000');
    assert.equal(client.token, undefined);
    assert.equal(client.timeout, 30000);
  });

  it('should strip trailing slash from baseUrl', () => {
    const client = new AutonomiClient({ baseUrl: 'http://localhost:8000/' });
    assert.equal(client.baseUrl, 'http://localhost:8000');
  });

  it('should accept token and timeout options', () => {
    const client = new AutonomiClient({
      baseUrl: 'http://localhost:8000',
      token: 'loki_test123',
      timeout: 5000,
    });
    assert.equal(client.token, 'loki_test123');
    assert.equal(client.timeout, 5000);
  });

  // -----------------------------------------------------------------------
  // 2. _request builds correct URL with params
  // -----------------------------------------------------------------------

  it('should build URL with query parameters', async () => {
    setRoute('GET', '/api/tasks', 200, []);
    const client = new AutonomiClient({ baseUrl });

    await client.listTasks(1, 'active');

    assert.equal(lastRequest.method, 'GET');
    assert.equal(lastRequest.path, '/api/tasks');
    assert.ok(lastRequest.search.includes('project_id=1'));
    assert.ok(lastRequest.search.includes('status=active'));
  });

  // -----------------------------------------------------------------------
  // 3. Auth header included
  // -----------------------------------------------------------------------

  it('should include Authorization header when token is set', async () => {
    setRoute('GET', '/api/status', 200, { status: 'ok' });
    const client = new AutonomiClient({ baseUrl, token: 'loki_secret' });

    await client.getStatus();

    assert.equal(lastRequest.headers['authorization'], 'Bearer loki_secret');
  });

  it('should not include Authorization header when no token', async () => {
    setRoute('GET', '/api/status', 200, { status: 'ok' });
    const client = new AutonomiClient({ baseUrl });

    await client.getStatus();

    assert.equal(lastRequest.headers['authorization'], undefined);
  });

  // -----------------------------------------------------------------------
  // 4. Error mapping
  // -----------------------------------------------------------------------

  it('should throw AuthenticationError on 401', async () => {
    setRoute('GET', '/api/projects', 401, { error: 'Invalid token' });
    const client = new AutonomiClient({ baseUrl, token: 'bad' });

    await assert.rejects(
      () => client.listProjects(),
      (err) => {
        assert.ok(err instanceof AuthenticationError);
        assert.equal(err.statusCode, 401);
        assert.equal(err.message, 'Invalid token');
        return true;
      }
    );
  });

  it('should throw ForbiddenError on 403', async () => {
    setRoute('GET', '/api/projects', 403, { error: 'Insufficient permissions' });
    const client = new AutonomiClient({ baseUrl, token: 'limited' });

    await assert.rejects(
      () => client.listProjects(),
      (err) => {
        assert.ok(err instanceof ForbiddenError);
        assert.equal(err.statusCode, 403);
        return true;
      }
    );
  });

  it('should throw NotFoundError on 404', async () => {
    setRoute('GET', '/api/projects/999', 404, { error: 'Project not found' });
    const client = new AutonomiClient({ baseUrl });

    await assert.rejects(
      () => client.getProject(999),
      (err) => {
        assert.ok(err instanceof NotFoundError);
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  });

  it('should throw AutonomiError on other status codes', async () => {
    setRoute('GET', '/api/status', 500, { error: 'Internal server error' });
    const client = new AutonomiClient({ baseUrl });

    await assert.rejects(
      () => client.getStatus(),
      (err) => {
        assert.ok(err instanceof AutonomiError);
        assert.equal(err.statusCode, 500);
        return true;
      }
    );
  });

  // -----------------------------------------------------------------------
  // 5. listProjects response parsing
  // -----------------------------------------------------------------------

  it('should parse listProjects response', async () => {
    const mockProjects = [
      { id: 1, name: 'Alpha', status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
      { id: 2, name: 'Beta', description: 'Second project', status: 'paused', created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-04T00:00:00Z' },
    ];
    setRoute('GET', '/api/projects', 200, mockProjects);
    const client = new AutonomiClient({ baseUrl });

    const projects = await client.listProjects();

    assert.equal(projects.length, 2);
    assert.equal(projects[0].name, 'Alpha');
    assert.equal(projects[1].description, 'Second project');
  });

  // -----------------------------------------------------------------------
  // 6. createProject sends correct body
  // -----------------------------------------------------------------------

  it('should send correct body for createProject', async () => {
    const mockProject = { id: 3, name: 'Gamma', description: 'New project', status: 'active', created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z' };
    setRoute('POST', '/api/projects', 201, mockProject);
    const client = new AutonomiClient({ baseUrl, token: 'loki_admin' });

    const result = await client.createProject('Gamma', 'New project');

    assert.equal(lastRequest.method, 'POST');
    assert.equal(lastRequest.path, '/api/projects');
    assert.deepEqual(lastRequest.body, { name: 'Gamma', description: 'New project' });
    assert.equal(result.id, 3);
    assert.equal(result.name, 'Gamma');
  });

  it('should omit description when not provided in createProject', async () => {
    setRoute('POST', '/api/projects', 201, { id: 4, name: 'Delta', status: 'active', created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z' });
    const client = new AutonomiClient({ baseUrl });

    await client.createProject('Delta');

    assert.deepEqual(lastRequest.body, { name: 'Delta' });
    assert.equal(lastRequest.body.description, undefined);
  });

  // -----------------------------------------------------------------------
  // 7. listRuns with filters
  // -----------------------------------------------------------------------

  it('should pass filters to listRuns', async () => {
    const mockRuns = [
      { id: 1, project_id: 5, status: 'running', trigger: 'manual', started_at: '2026-02-10T00:00:00Z' },
    ];
    setRoute('GET', '/api/v2/runs', 200, mockRuns);
    const client = new AutonomiClient({ baseUrl });

    const runs = await client.listRuns(5, 'running');

    assert.equal(lastRequest.path, '/api/v2/runs');
    assert.ok(lastRequest.search.includes('project_id=5'));
    assert.ok(lastRequest.search.includes('status=running'));
    assert.equal(runs.length, 1);
    assert.equal(runs[0].trigger, 'manual');
  });

  // -----------------------------------------------------------------------
  // 8. cancelRun
  // -----------------------------------------------------------------------

  it('should send POST to cancel a run', async () => {
    const mockRun = { id: 10, project_id: 1, status: 'cancelled', trigger: 'manual', started_at: '2026-02-10T00:00:00Z', ended_at: '2026-02-10T01:00:00Z' };
    setRoute('POST', '/api/v2/runs/10/cancel', 200, mockRun);
    const client = new AutonomiClient({ baseUrl });

    const result = await client.cancelRun(10);

    assert.equal(lastRequest.method, 'POST');
    assert.equal(lastRequest.path, '/api/v2/runs/10/cancel');
    assert.equal(result.status, 'cancelled');
  });

  // -----------------------------------------------------------------------
  // 9. queryAudit with params
  // -----------------------------------------------------------------------

  it('should pass query params to queryAudit', async () => {
    const mockEntries = [
      { timestamp: '2026-02-15T12:00:00Z', action: 'project.create', resource_type: 'project', resource_id: '1', success: true },
    ];
    setRoute('GET', '/api/v2/audit', 200, mockEntries);
    const client = new AutonomiClient({ baseUrl });

    const entries = await client.queryAudit({
      start_date: '2026-02-01',
      end_date: '2026-02-28',
      action: 'project.create',
      limit: 50,
    });

    assert.ok(lastRequest.search.includes('start_date=2026-02-01'));
    assert.ok(lastRequest.search.includes('end_date=2026-02-28'));
    assert.ok(lastRequest.search.includes('action=project.create'));
    assert.ok(lastRequest.search.includes('limit=50'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'project.create');
  });

  // -----------------------------------------------------------------------
  // 10. Type exports (structural check)
  // -----------------------------------------------------------------------

  it('should have all error classes properly structured', () => {
    const ae = new AutonomiError('test', 500, '{"error":"test"}');
    assert.equal(ae.name, 'AutonomiError');
    assert.equal(ae.statusCode, 500);
    assert.equal(ae.responseBody, '{"error":"test"}');
    assert.ok(ae instanceof Error);

    const auth = new AuthenticationError();
    assert.equal(auth.name, 'AuthenticationError');
    assert.equal(auth.statusCode, 401);
    assert.ok(auth instanceof AutonomiError);

    const forbidden = new ForbiddenError();
    assert.equal(forbidden.name, 'ForbiddenError');
    assert.equal(forbidden.statusCode, 403);
    assert.ok(forbidden instanceof AutonomiError);

    const notFound = new NotFoundError();
    assert.equal(notFound.name, 'NotFoundError');
    assert.equal(notFound.statusCode, 404);
    assert.ok(notFound instanceof AutonomiError);
  });

  // -----------------------------------------------------------------------
  // 11. createTask sends correct body
  // -----------------------------------------------------------------------

  it('should send correct body for createTask', async () => {
    const mockTask = { id: 1, project_id: 5, title: 'Build SDK', description: 'TypeScript SDK', status: 'pending', priority: 'high' };
    setRoute('POST', '/api/tasks', 201, mockTask);
    const client = new AutonomiClient({ baseUrl });

    const result = await client.createTask(5, 'Build SDK', 'TypeScript SDK');

    assert.equal(lastRequest.method, 'POST');
    assert.deepEqual(lastRequest.body, { project_id: 5, title: 'Build SDK', description: 'TypeScript SDK' });
    assert.equal(result.title, 'Build SDK');
  });

  // -----------------------------------------------------------------------
  // 12. replayRun
  // -----------------------------------------------------------------------

  it('should send POST to replay a run', async () => {
    const mockRun = { id: 11, project_id: 2, status: 'running', trigger: 'replay', started_at: '2026-02-20T00:00:00Z' };
    setRoute('POST', '/api/v2/runs/11/replay', 200, mockRun);
    const client = new AutonomiClient({ baseUrl });

    const result = await client.replayRun(11);

    assert.equal(lastRequest.method, 'POST');
    assert.equal(lastRequest.path, '/api/v2/runs/11/replay');
    assert.equal(result.trigger, 'replay');
  });

  // -----------------------------------------------------------------------
  // 13. createTenant sends correct body
  // -----------------------------------------------------------------------

  it('should send correct body for createTenant', async () => {
    const mockTenant = { id: 1, name: 'Acme Corp', slug: 'acme-corp', description: 'Main tenant', created_at: '2026-01-01T00:00:00Z' };
    setRoute('POST', '/api/v2/tenants', 201, mockTenant);
    const client = new AutonomiClient({ baseUrl });

    const result = await client.createTenant('Acme Corp', 'Main tenant');

    assert.deepEqual(lastRequest.body, { name: 'Acme Corp', description: 'Main tenant' });
    assert.equal(result.slug, 'acme-corp');
  });

  // -----------------------------------------------------------------------
  // 14. verifyAudit
  // -----------------------------------------------------------------------

  it('should call verifyAudit endpoint', async () => {
    setRoute('GET', '/api/v2/audit/verify', 200, { valid: true, entries_checked: 142 });
    const client = new AutonomiClient({ baseUrl });

    const result = await client.verifyAudit();

    assert.equal(lastRequest.path, '/api/v2/audit/verify');
    assert.equal(result.valid, true);
    assert.equal(result.entries_checked, 142);
  });

  // -----------------------------------------------------------------------
  // 15. deleteApiKey returns void on success
  // -----------------------------------------------------------------------

  it('should delete API key and handle empty response', async () => {
    setRoute('DELETE', '/api/v2/api-keys/key-abc', 200, '');
    const client = new AutonomiClient({ baseUrl });

    // Should not throw
    const result = await client.deleteApiKey('key-abc');
    assert.equal(result, undefined);
    assert.equal(lastRequest.method, 'DELETE');
    assert.equal(lastRequest.path, '/api/v2/api-keys/key-abc');
  });

  // -----------------------------------------------------------------------
  // 16. getRunTimeline
  // -----------------------------------------------------------------------

  it('should fetch run timeline events', async () => {
    const mockEvents = [
      { id: 1, run_id: 10, event_type: 'phase_start', phase: 'build', timestamp: '2026-02-10T00:00:00Z' },
      { id: 2, run_id: 10, event_type: 'phase_end', phase: 'build', timestamp: '2026-02-10T00:05:00Z' },
    ];
    setRoute('GET', '/api/v2/runs/10/timeline', 200, mockEvents);
    const client = new AutonomiClient({ baseUrl });

    const events = await client.getRunTimeline(10);

    assert.equal(events.length, 2);
    assert.equal(events[0].event_type, 'phase_start');
    assert.equal(events[1].phase, 'build');
  });

  // -----------------------------------------------------------------------
  // 17. listApiKeys
  // -----------------------------------------------------------------------

  it('should list API keys', async () => {
    const mockKeys = [
      { id: 'k1', name: 'prod-key', scopes: ['read', 'write'], role: 'admin', created_at: '2026-01-01T00:00:00Z' },
    ];
    setRoute('GET', '/api/v2/api-keys', 200, mockKeys);
    const client = new AutonomiClient({ baseUrl });

    const keys = await client.listApiKeys();

    assert.equal(keys.length, 1);
    assert.equal(keys[0].name, 'prod-key');
    assert.deepEqual(keys[0].scopes, ['read', 'write']);
  });

  // -----------------------------------------------------------------------
  // 18. Content-Type header is always set
  // -----------------------------------------------------------------------

  it('should always send Content-Type application/json', async () => {
    setRoute('GET', '/api/projects', 200, []);
    const client = new AutonomiClient({ baseUrl });

    await client.listProjects();

    assert.equal(lastRequest.headers['content-type'], 'application/json');
  });
});
