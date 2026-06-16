'use strict';

/**
 * Loki Mode Policy Engine - Approval Gate Integration Tests
 *
 * These tests exercise the FULL integration path that the build loop uses:
 *
 *   policy file on disk (.loki/policies.json|yaml)
 *     -> PolicyEngine loads + parses approval_gates
 *     -> index.js init() wires an ApprovalGateManager
 *     -> policy.requestApproval(phase, ctx) pauses, resolves, audits
 *
 * They prove the intelligent default mandated by the spec:
 *   - A gate engages ONLY when a policy file DECLARES an approval gate for
 *     that phase. Zero-config runs (no policy file) auto-approve instantly
 *     and never pause -- a default autonomous run is never blocked.
 *
 * The isolated unit tests for ApprovalGateManager live in approval.test.js.
 * This file deliberately goes through the public src/policies entry point so
 * that the wiring (engine -> manager) is verified, not just the class.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const policy = require('../../src/policies');

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loki-approval-integ-'));
  fs.mkdirSync(path.join(dir, '.loki', 'state'), { recursive: true });
  return dir;
}

function writePolicyFile(dir, obj) {
  const p = path.join(dir, '.loki', 'policies.json');
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// -------------------------------------------------------------------
// Zero-config (no policy file): never gates, never pauses
// -------------------------------------------------------------------

describe('approval integration - zero-config (no policy file)', function () {
  let tempDir;

  beforeEach(function () {
    tempDir = createTempDir();
  });

  afterEach(function () {
    policy.destroy();
    cleanup(tempDir);
  });

  it('auto-approves instantly when no policy file exists (no pause, no prompt)', async function () {
    policy.init(tempDir);

    const start = Date.now();
    const result = await policy.requestApproval('deploy', { branch: 'main' });
    const elapsed = Date.now() - start;

    assert.strictEqual(result.approved, true, 'must auto-approve a zero-config run');
    assert.strictEqual(result.method, 'auto', 'method must be auto, not manual/timeout');
    assert.ok(elapsed < 250, 'must resolve effectively instantly, got ' + elapsed + 'ms');
  });

  it('reports no approval manager is wired for a zero-config run', function () {
    policy.init(tempDir);
    assert.strictEqual(policy.hasPolicies(), false);
    assert.strictEqual(policy.getApprovalManager(), null);
  });

  it('resolveApproval is a no-op (returns false) with no policy file', function () {
    policy.init(tempDir);
    assert.strictEqual(policy.resolveApproval('any-id', true), false);
  });
});

// -------------------------------------------------------------------
// Policy file present but NO approval_gates declared: still pass-through
// -------------------------------------------------------------------

describe('approval integration - policy file without approval_gates', function () {
  let tempDir;

  beforeEach(function () {
    tempDir = createTempDir();
  });

  afterEach(function () {
    policy.destroy();
    cleanup(tempDir);
  });

  it('auto-approves any phase when no approval_gates are declared', async function () {
    // A policy file exists (e.g. only resource/data rules) but declares no gates.
    writePolicyFile(tempDir, {
      policies: {
        data: [{ name: 'no-secrets', type: 'secret_detection', action: 'deny' }],
      },
    });
    policy.init(tempDir);

    assert.strictEqual(policy.hasPolicies(), true, 'policy file is loaded');

    const result = await policy.requestApproval('deploy', { branch: 'main' });
    assert.strictEqual(result.approved, true);
    assert.strictEqual(result.method, 'auto', 'undeclared phase must not pause');
  });

  it('does not pause a phase that has no matching gate', async function () {
    writePolicyFile(tempDir, {
      policies: {
        approval_gates: [
          { name: 'deploy-gate', phase: 'deploy', timeout_minutes: 30 },
        ],
      },
    });
    policy.init(tempDir);

    // "build" is not gated -- must auto-approve even though a gate exists for "deploy".
    const result = await policy.requestApproval('build', {});
    assert.strictEqual(result.approved, true);
    assert.strictEqual(result.method, 'auto');
  });
});

// -------------------------------------------------------------------
// Policy file declares a gate: engages, pauses, resolves on webhook/timeout
// -------------------------------------------------------------------

describe('approval integration - declared gate engages', function () {
  let tempDir;

  beforeEach(function () {
    tempDir = createTempDir();
  });

  afterEach(function () {
    policy.destroy();
    cleanup(tempDir);
  });

  it('pauses on a declared gate and resolves on manual/webhook approval + audits', async function () {
    writePolicyFile(tempDir, {
      policies: {
        approval_gates: [
          // Long timeout so the manual resolution path is what completes it.
          { name: 'release-gate', phase: 'release', timeout_minutes: 30 },
        ],
      },
    });
    policy.init(tempDir);

    const mgr = policy.getApprovalManager();
    assert.ok(mgr, 'an approval manager must be wired when a gate is declared');
    assert.strictEqual(mgr.hasGate('release'), true);

    // Start the request -- it must NOT resolve on its own (it is pending).
    const promise = policy.requestApproval('release', { version: '9.9.9' });

    // It is genuinely paused: exactly one pending request exists.
    const pending = mgr.getPendingRequests();
    assert.strictEqual(pending.length, 1, 'gate must pause execution (one pending request)');
    const requestId = pending[0].id;
    assert.match(requestId, /^apr-[0-9a-f]{32}$/);

    // External approval (this is what a webhook callback would trigger).
    const ok = policy.resolveApproval(requestId, true, 'shipped by release manager');
    assert.strictEqual(ok, true);

    const result = await promise;
    assert.strictEqual(result.approved, true);
    assert.strictEqual(result.method, 'manual');
    assert.strictEqual(result.reason, 'shipped by release manager');

    // Full audit trail is persisted to disk and readable.
    const audit = mgr.getAuditTrail();
    assert.ok(audit.length >= 1);
    const last = audit[audit.length - 1];
    assert.strictEqual(last.phase, 'release');
    assert.strictEqual(last.gate, 'release-gate');
    assert.strictEqual(last.status, 'approved');
    assert.ok(last.resolvedAt, 'audit entry must record resolution time');

    const stateFile = path.join(tempDir, '.loki', 'state', 'approvals.json');
    assert.ok(fs.existsSync(stateFile), 'approval state must persist to .loki/state/approvals.json');
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(saved.audit.some(function (e) { return e.id === requestId && e.status === 'approved'; }));
  });

  it('fails closed (rejects) when a declared gate times out without approval', async function () {
    writePolicyFile(tempDir, {
      policies: {
        approval_gates: [
          // 0.01 min == 0.6s, short enough for the test to observe the timeout.
          { name: 'deploy-gate', phase: 'deploy', timeout_minutes: 0.01 },
        ],
      },
    });
    policy.init(tempDir);

    const result = await policy.requestApproval('deploy', { branch: 'main' });
    assert.strictEqual(result.approved, false, 'default gate behavior must fail closed');
    assert.strictEqual(result.method, 'timeout');
    assert.ok(result.reason.toLowerCase().includes('timeout'));

    // The timed-out decision is audited.
    const mgr = policy.getApprovalManager();
    const audit = mgr.getAuditTrail();
    const last = audit[audit.length - 1];
    assert.strictEqual(last.status, 'timed_out');
    assert.strictEqual(last.phase, 'deploy');
  });

  it('auto-approves on timeout only when the gate opts in', async function () {
    writePolicyFile(tempDir, {
      policies: {
        approval_gates: [
          {
            name: 'staging-gate',
            phase: 'staging',
            timeout_minutes: 0.01,
            auto_approve_on_timeout: true,
          },
        ],
      },
    });
    policy.init(tempDir);

    const result = await policy.requestApproval('staging', {});
    assert.strictEqual(result.approved, true, 'opt-in auto-approve-on-timeout must approve');
    assert.strictEqual(result.method, 'timeout');
  });
});

// -------------------------------------------------------------------
// YAML policy file path (the documented fallback format) wires gates too
// -------------------------------------------------------------------

describe('approval integration - YAML policy file', function () {
  let tempDir;

  beforeEach(function () {
    tempDir = createTempDir();
  });

  afterEach(function () {
    policy.destroy();
    cleanup(tempDir);
  });

  it('loads approval gates declared in policies.yaml and pauses', async function () {
    const yaml = [
      'policies:',
      '  approval_gates:',
      '    - name: yaml-deploy-gate',
      '      phase: deploy',
      '      timeout_minutes: 30',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tempDir, '.loki', 'policies.yaml'), yaml, 'utf8');
    policy.init(tempDir);

    const mgr = policy.getApprovalManager();
    assert.ok(mgr, 'YAML-declared gate must wire an approval manager');
    assert.strictEqual(mgr.hasGate('deploy'), true);

    const promise = policy.requestApproval('deploy', {});
    const pending = mgr.getPendingRequests();
    assert.strictEqual(pending.length, 1);

    policy.resolveApproval(pending[0].id, false, 'blocked in YAML test');
    const result = await promise;
    assert.strictEqual(result.approved, false);
    assert.strictEqual(result.reason, 'blocked in YAML test');
  });
});
