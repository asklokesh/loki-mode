'use strict';
// Verifies the built SDK maps 501 and 410 to NotAvailableOnControlPlaneError.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

describe('NotAvailableOnControlPlaneError', () => {
  let server, port, sdk;
  before(async () => {
    sdk = await import('../dist/index.js');
    server = http.createServer((req, res) => {
      const code = req.url.startsWith('/api/projects') ? 501 : req.url.startsWith('/api/v2/tenants') ? 410 : 404;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'x' }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => server.close());

  it('501 raises NotAvailableOnControlPlaneError', async () => {
    const c = new sdk.AutonomiClient({ baseUrl: `http://127.0.0.1:${port}` });
    await assert.rejects(() => c.listProjects(), (e) => {
      assert.ok(e instanceof sdk.NotAvailableOnControlPlaneError);
      assert.equal(e.statusCode, 501);
      assert.match(e.message, /not available on the Control Plane/);
      return true;
    });
  });
  it('410 raises NotAvailableOnControlPlaneError', async () => {
    const c = new sdk.AutonomiClient({ baseUrl: `http://127.0.0.1:${port}` });
    await assert.rejects(() => c.listTenants(), (e) => e instanceof sdk.NotAvailableOnControlPlaneError && e.statusCode === 410);
  });
  it('404 stays NotFoundError', async () => {
    const c = new sdk.AutonomiClient({ baseUrl: `http://127.0.0.1:${port}` });
    await assert.rejects(() => c.getStatus(), (e) => e instanceof sdk.NotFoundError);
  });
});
