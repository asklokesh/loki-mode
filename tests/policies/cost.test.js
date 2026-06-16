'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CostController } = require('../../src/policies/cost');

// -------------------------------------------------------------------
// Helper
// -------------------------------------------------------------------

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loki-cost-test-'));
  fs.mkdirSync(path.join(dir, '.loki', 'state'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// -------------------------------------------------------------------
// Tests: CostController - no budget
// -------------------------------------------------------------------

describe('CostController - no budget configured', function () {
  let tempDir;
  let controller;

  before(function () {
    tempDir = createTempDir();
    controller = new CostController(tempDir, []);
  });

  after(function () {
    controller.removeAllListeners();
    cleanup(tempDir);
  });

  it('should return unlimited budget when no resource policies', function () {
    const budget = controller.checkBudget();
    assert.strictEqual(budget.remaining, Infinity);
    assert.strictEqual(budget.percentage, 0);
    assert.strictEqual(budget.alerts.length, 0);
    assert.strictEqual(budget.exceeded, false);
  });

  it('should accept usage recording without errors', function () {
    controller.recordUsage('proj-1', { agentId: 'agent-1', model: 'opus', tokens: 1000 });
    // No crash = pass
  });
});

// -------------------------------------------------------------------
// Tests: CostController - with budget
// -------------------------------------------------------------------

describe('CostController - with budget', function () {
  let tempDir;
  let controller;
  const resourcePolicies = [
    {
      name: 'token-budget',
      max_tokens: 10000,
      alerts: [50, 80, 100],
      on_exceed: 'shutdown',
    },
  ];

  beforeEach(function () {
    tempDir = createTempDir();
    controller = new CostController(tempDir, resourcePolicies);
  });

  afterEach(function () {
    controller.removeAllListeners();
    cleanup(tempDir);
  });

  it('should track token usage per project', function () {
    controller.recordUsage('proj-1', { agentId: 'a1', model: 'opus', tokens: 2000 });
    controller.recordUsage('proj-1', { agentId: 'a2', model: 'sonnet', tokens: 1000 });

    const report = controller.getProjectReport('proj-1');
    assert.ok(report);
    assert.strictEqual(report.totalTokens, 3000);
    assert.strictEqual(report.entries.length, 2);
  });

  it('should track per-agent totals', function () {
    controller.recordUsage('proj-1', { agentId: 'agent-1', model: 'opus', tokens: 500 });
    controller.recordUsage('proj-1', { agentId: 'agent-1', model: 'opus', tokens: 700 });
    controller.recordUsage('proj-1', { agentId: 'agent-2', model: 'sonnet', tokens: 300 });

    const agents = controller.getAgentReport();
    assert.strictEqual(agents['agent-1'].totalTokens, 1200);
    assert.strictEqual(agents['agent-2'].totalTokens, 300);
  });

  it('should check budget percentage correctly', function () {
    controller.recordUsage('proj-1', { tokens: 5000 });
    const budget = controller.checkBudget('proj-1');
    assert.strictEqual(budget.percentage, 50);
    assert.strictEqual(budget.remaining, 5000);
    assert.strictEqual(budget.exceeded, false);
  });

  it('should report alerts at 50% threshold', function () {
    controller.recordUsage('proj-1', { tokens: 5000 });
    const budget = controller.checkBudget('proj-1');
    assert.ok(budget.alerts.length >= 1);
    assert.ok(budget.alerts.some(function (a) { return a.threshold === 50; }));
  });

  it('should report alerts at 80% threshold', function () {
    controller.recordUsage('proj-1', { tokens: 8000 });
    const budget = controller.checkBudget('proj-1');
    assert.ok(budget.alerts.some(function (a) { return a.threshold === 80; }));
  });

  it('should report exceeded at 100%', function () {
    controller.recordUsage('proj-1', { tokens: 10000 });
    const budget = controller.checkBudget('proj-1');
    assert.strictEqual(budget.exceeded, true);
    assert.strictEqual(budget.remaining, 0);
  });

  it('should emit alert events at thresholds', function () {
    const alerts = [];
    controller.on('alert', function (data) {
      alerts.push(data);
    });

    controller.recordUsage('proj-1', { tokens: 5000 }); // 50%
    assert.ok(alerts.length >= 1);
    assert.strictEqual(alerts[0].threshold, 50);
  });

  it('should emit shutdown event when budget exceeded', function () {
    let shutdownEvent = null;
    controller.on('shutdown', function (data) {
      shutdownEvent = data;
    });

    controller.recordUsage('proj-1', { tokens: 10000 });
    assert.ok(shutdownEvent);
    assert.strictEqual(shutdownEvent.reason, 'Token budget exceeded');
  });

  it('should only emit shutdown once', function () {
    let shutdownCount = 0;
    controller.on('shutdown', function () {
      shutdownCount++;
    });

    controller.recordUsage('proj-1', { tokens: 10000 });
    controller.recordUsage('proj-1', { tokens: 5000 }); // Over budget again
    assert.strictEqual(shutdownCount, 1);
  });

  it('should not emit duplicate alerts for same threshold', function () {
    const alerts = [];
    controller.on('alert', function (data) {
      alerts.push(data);
    });

    controller.recordUsage('proj-1', { tokens: 5500 }); // 55%
    controller.recordUsage('proj-1', { tokens: 500 });   // 60%

    // Only one alert for 50% threshold
    const fiftyAlerts = alerts.filter(function (a) { return a.threshold === 50; });
    assert.strictEqual(fiftyAlerts.length, 1);
  });

  it('should persist cost data to file', function () {
    controller.recordUsage('proj-1', { agentId: 'a1', model: 'opus', tokens: 1000 });

    const stateFile = path.join(tempDir, '.loki', 'state', 'costs.json');
    assert.ok(fs.existsSync(stateFile));

    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(saved.totalTokens, 1000);
    assert.ok(saved.projects['proj-1']);
  });

  it('should reset tracking data', function () {
    controller.recordUsage('proj-1', { tokens: 5000 });
    controller.reset();

    const budget = controller.checkBudget('proj-1');
    assert.strictEqual(budget.percentage, 0);
    assert.strictEqual(budget.exceeded, false);

    const agents = controller.getAgentReport();
    assert.deepStrictEqual(agents, {});
  });

  it('should return history of events', function () {
    controller.recordUsage('proj-1', { tokens: 10000 }); // triggers 50%, 80%, 100% alerts + shutdown

    const history = controller.getHistory();
    assert.ok(history.length > 0);
    assert.ok(history.some(function (h) { return h.type === 'alert'; }));
    assert.ok(history.some(function (h) { return h.type === 'shutdown'; }));
  });
});

// -------------------------------------------------------------------
// Tests: CostController - state persistence across instances
// -------------------------------------------------------------------

describe('CostController - persistence', function () {
  let tempDir;
  const resourcePolicies = [
    { name: 'budget', max_tokens: 100000, alerts: [50, 80, 100], on_exceed: 'shutdown' },
  ];

  before(function () {
    tempDir = createTempDir();
  });

  after(function () {
    cleanup(tempDir);
  });

  it('should load previous state on new instance', function () {
    const c1 = new CostController(tempDir, resourcePolicies);
    c1.recordUsage('proj-1', { agentId: 'a1', tokens: 5000 });
    c1.removeAllListeners();

    // Create new instance from same directory
    const c2 = new CostController(tempDir, resourcePolicies);
    const budget = c2.checkBudget('proj-1');
    assert.strictEqual(budget.percentage, 5); // 5000 / 100000 = 5%
    c2.removeAllListeners();
  });
});

// -------------------------------------------------------------------
// Tests: CostController - per-project shutdown flag (Finding 7 fix)
// -------------------------------------------------------------------

describe('CostController - per-project shutdown isolation', function () {
  let tempDir;
  let controller;
  const resourcePolicies = [
    { name: 'budget', max_tokens: 1000, alerts: [100], on_exceed: 'shutdown' },
  ];

  before(function () {
    tempDir = createTempDir();
  });

  beforeEach(function () {
    controller = new CostController(tempDir, resourcePolicies);
  });

  afterEach(function () {
    controller.removeAllListeners();
    controller.reset();
  });

  after(function () {
    cleanup(tempDir);
  });

  it('should emit shutdown for project-a and still emit for project-b independently', function () {
    const shutdowns = [];
    controller.on('shutdown', function (data) { shutdowns.push(data.projectId); });

    // Exceed budget for project-a
    controller.recordUsage('proj-a', { tokens: 1001 });
    assert.strictEqual(shutdowns.length, 1);
    assert.strictEqual(shutdowns[0], 'proj-a');

    // proj-a shutdown should not block proj-b
    controller.recordUsage('proj-b', { tokens: 1001 });
    assert.strictEqual(shutdowns.length, 2);
    assert.strictEqual(shutdowns[1], 'proj-b');
  });

  it('should not emit duplicate shutdown for same project', function () {
    const shutdowns = [];
    controller.on('shutdown', function (data) { shutdowns.push(data.projectId); });

    controller.recordUsage('proj-a', { tokens: 1001 });
    controller.recordUsage('proj-a', { tokens: 1001 }); // second call should not re-emit
    assert.strictEqual(shutdowns.length, 1, 'Shutdown must only be emitted once per project');
  });
});

// -------------------------------------------------------------------
// Tests: CostController - org/tenant cost governance (P3-8)
// -------------------------------------------------------------------

describe('CostController - org/tenant governance', function () {
  let tempDir;
  let controller;
  // Explicit org_id avoids any git-remote / env auto-detection so the rollup
  // key is deterministic in tests.
  const orgPolicies = [
    {
      name: 'org-budget',
      org_max_tokens: 10000,
      org_alerts: [50, 100],
      org_on_exceed: 'pause',
      org_id: 'acme',
    },
  ];

  beforeEach(function () {
    tempDir = createTempDir();
    controller = new CostController(tempDir, orgPolicies);
  });

  afterEach(function () {
    controller.removeAllListeners();
    cleanup(tempDir);
  });

  it('should roll up spend across multiple projects under one org', function () {
    controller.recordUsage('proj-1', { tokens: 3000 });
    controller.recordUsage('proj-2', { tokens: 2000 });

    const org = controller.getOrgReport('acme');
    assert.ok(org);
    assert.strictEqual(org.totalTokens, 5000);
    assert.strictEqual(org.projects['proj-1'], 3000);
    assert.strictEqual(org.projects['proj-2'], 2000);
  });

  it('should allow while aggregate org spend is under the ceiling', function () {
    controller.recordUsage('proj-1', { tokens: 4000 });
    controller.recordUsage('proj-2', { tokens: 4000 }); // 8000 < 10000

    const budget = controller.checkOrgBudget('acme');
    assert.strictEqual(budget.exceeded, false);
    assert.strictEqual(budget.decision, 'allow');
    assert.strictEqual(budget.percentage, 80);
    assert.strictEqual(budget.remaining, 2000);
  });

  it('should deny/pause when aggregate org spend crosses the ceiling', function () {
    let event = null;
    controller.on('org_ceiling', function (data) { event = data; });

    // Neither project alone exceeds, but combined they cross the org ceiling.
    controller.recordUsage('proj-1', { tokens: 6000 });
    controller.recordUsage('proj-2', { tokens: 6000 }); // 12000 >= 10000

    const budget = controller.checkOrgBudget('acme');
    assert.strictEqual(budget.exceeded, true);
    assert.strictEqual(budget.decision, 'pause');
    assert.strictEqual(budget.remaining, 0);

    assert.ok(event, 'org_ceiling event must fire');
    assert.strictEqual(event.decision, 'pause');
    assert.strictEqual(event.orgId, 'acme');
  });

  it('should write an org_ceiling_exceeded audit record', function () {
    controller.recordUsage('proj-1', { tokens: 11000 });

    const history = controller.getHistory();
    const audit = history.filter(function (h) { return h.type === 'org_ceiling_exceeded'; });
    assert.strictEqual(audit.length, 1);
    assert.strictEqual(audit[0].orgId, 'acme');
    assert.strictEqual(audit[0].decision, 'pause');
    assert.strictEqual(audit[0].consumed, 11000);
    assert.strictEqual(audit[0].max, 10000);
  });

  it('should emit org_alert at thresholds without duplicates', function () {
    const alerts = [];
    controller.on('org_alert', function (data) { alerts.push(data); });

    controller.recordUsage('proj-1', { tokens: 5000 }); // 50%
    controller.recordUsage('proj-2', { tokens: 500 });  // 55% (no new threshold)

    const fifty = alerts.filter(function (a) { return a.threshold === 50; });
    assert.strictEqual(fifty.length, 1);
  });

  it('should emit org_ceiling only once per org', function () {
    let count = 0;
    controller.on('org_ceiling', function () { count++; });

    controller.recordUsage('proj-1', { tokens: 11000 });
    controller.recordUsage('proj-2', { tokens: 5000 }); // still over, must not re-emit
    assert.strictEqual(count, 1);
  });

  it("warn mode should record/alert but never set a blocking decision", function () {
    const warnDir = createTempDir();
    const warnController = new CostController(warnDir, [
      { name: 'org-budget', org_max_tokens: 1000, org_on_exceed: 'warn', org_id: 'acme' },
    ]);
    let ceiling = null;
    warnController.on('org_ceiling', function (d) { ceiling = d; });

    warnController.recordUsage('proj-1', { tokens: 2000 });

    const budget = warnController.checkOrgBudget('acme');
    assert.strictEqual(budget.exceeded, true);
    assert.strictEqual(budget.decision, 'allow', 'warn mode never blocks');
    assert.strictEqual(ceiling, null, 'warn mode does not fire the blocking ceiling event');

    warnController.removeAllListeners();
    cleanup(warnDir);
  });

  it('should auto-detect org id from LOKI_ORG_ID env (zero-config)', function () {
    const envDir = createTempDir();
    const prev = process.env.LOKI_ORG_ID;
    process.env.LOKI_ORG_ID = 'env-org';
    try {
      // No org_id on the policy -> falls through to env detection.
      const c = new CostController(envDir, [
        { name: 'org-budget', org_max_tokens: 10000 },
      ]);
      c.recordUsage('proj-1', { tokens: 1000 });
      const org = c.getOrgReport('env-org');
      assert.ok(org, 'org should be keyed by the env-detected id');
      assert.strictEqual(org.totalTokens, 1000);
      c.removeAllListeners();
    } finally {
      if (prev === undefined) delete process.env.LOKI_ORG_ID;
      else process.env.LOKI_ORG_ID = prev;
      cleanup(envDir);
    }
  });

  it('should persist org rollup across controller instances', function () {
    controller.recordUsage('proj-1', { tokens: 4000 });
    controller.removeAllListeners();

    const c2 = new CostController(tempDir, orgPolicies);
    c2.recordUsage('proj-2', { tokens: 3000 });
    const budget = c2.checkOrgBudget('acme');
    assert.strictEqual(budget.consumed, 7000); // 4000 persisted + 3000 new
    c2.removeAllListeners();
  });
});

// -------------------------------------------------------------------
// Tests: CostController - no org config = unchanged per-run behavior
// -------------------------------------------------------------------

describe('CostController - no org config (backward compatibility)', function () {
  let tempDir;
  let controller;
  const resourcePolicies = [
    { name: 'token-budget', max_tokens: 10000, alerts: [50, 80, 100], on_exceed: 'shutdown' },
  ];

  beforeEach(function () {
    tempDir = createTempDir();
    controller = new CostController(tempDir, resourcePolicies);
  });

  afterEach(function () {
    controller.removeAllListeners();
    cleanup(tempDir);
  });

  it('checkOrgBudget returns transparent unlimited result', function () {
    controller.recordUsage('proj-1', { tokens: 9000 });
    const budget = controller.checkOrgBudget();
    assert.strictEqual(budget.exceeded, false);
    assert.strictEqual(budget.decision, 'allow');
    assert.strictEqual(budget.remaining, Infinity);
    assert.strictEqual(budget.orgId, null);
  });

  it('does not populate the org rollup when no org ceiling configured', function () {
    controller.recordUsage('proj-1', { tokens: 5000 });
    const orgs = controller.getOrgReport();
    assert.deepStrictEqual(orgs, {});
  });

  it('per-run budget behavior is unchanged (shutdown still fires)', function () {
    let shutdown = null;
    controller.on('shutdown', function (d) { shutdown = d; });
    controller.on('org_ceiling', function () {
      assert.fail('org_ceiling must not fire without org config');
    });
    controller.recordUsage('proj-1', { tokens: 10000 });
    assert.ok(shutdown);
    assert.strictEqual(shutdown.reason, 'Token budget exceeded');
  });
});
