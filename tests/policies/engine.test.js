'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PolicyEngine, parseSimpleYaml } = require('../../src/policies/engine');

// -------------------------------------------------------------------
// Helper: create a temp directory with policy files
// -------------------------------------------------------------------

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loki-policy-test-'));
  fs.mkdirSync(path.join(dir, '.loki'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writePolicyJson(dir, policies) {
  fs.writeFileSync(
    path.join(dir, '.loki', 'policies.json'),
    JSON.stringify(policies, null, 2),
    'utf8'
  );
}

function writePolicyYaml(dir, yamlContent) {
  fs.writeFileSync(
    path.join(dir, '.loki', 'policies.yaml'),
    yamlContent,
    'utf8'
  );
}

// -------------------------------------------------------------------
// Tests: YAML parser
// -------------------------------------------------------------------

describe('parseSimpleYaml', function () {
  it('should parse basic key-value pairs', function () {
    const result = parseSimpleYaml('version: 1\nname: test');
    assert.deepStrictEqual(result, { version: 1, name: 'test' });
  });

  it('should parse inline arrays', function () {
    const result = parseSimpleYaml('items: [a, b, c]');
    assert.deepStrictEqual(result, { items: ['a', 'b', 'c'] });
  });

  it('should parse numeric inline arrays', function () {
    const result = parseSimpleYaml('alerts: [50, 80, 100]');
    assert.deepStrictEqual(result, { alerts: [50, 80, 100] });
  });

  it('should handle boolean and null scalars', function () {
    const result = parseSimpleYaml('enabled: true\ndisabled: false\nempty: null');
    assert.deepStrictEqual(result, { enabled: true, disabled: false, empty: null });
  });

  it('should handle quoted strings', function () {
    const result = parseSimpleYaml('rule: "file_path must start with project_dir"');
    assert.strictEqual(result.rule, 'file_path must start with project_dir');
  });

  it('should skip comments and empty lines', function () {
    const yaml = '# This is a comment\nversion: 1\n\n# Another comment\nname: test';
    const result = parseSimpleYaml(yaml);
    assert.deepStrictEqual(result, { version: 1, name: 'test' });
  });

  it('should return null for empty input', function () {
    assert.strictEqual(parseSimpleYaml(''), null);
    assert.strictEqual(parseSimpleYaml(null), null);
  });

  it('should parse the full policy YAML format', function () {
    const yaml = [
      'version: 1',
      'policies:',
      '  pre_execution:',
      '    - name: sandbox-files',
      '      rule: "file_path must start with project_dir"',
      '      action: deny',
      '    - name: max-agents',
      '      rule: "active_agents <= 10"',
      '      action: deny',
      '  resource:',
      '    - name: token-budget',
      '      max_tokens: 1000000',
      '      alerts: [50, 80, 100]',
      '      on_exceed: shutdown',
      '    - name: approved-providers',
      '      providers: [claude, openai]',
      '      action: deny',
      '  approval_gates:',
      '    - name: pre-deploy',
      '      phase: deploy',
      '      timeout_minutes: 30',
      '      webhook: https://hooks.slack.com/test',
    ].join('\n');

    const result = parseSimpleYaml(yaml);
    assert.strictEqual(result.version, 1);
    assert.ok(result.policies);
    assert.ok(Array.isArray(result.policies.pre_execution));
    assert.strictEqual(result.policies.pre_execution.length, 2);
    assert.strictEqual(result.policies.pre_execution[0].name, 'sandbox-files');
    assert.ok(Array.isArray(result.policies.resource));
    assert.strictEqual(result.policies.resource[0].max_tokens, 1000000);
    assert.deepStrictEqual(result.policies.resource[0].alerts, [50, 80, 100]);
    assert.ok(Array.isArray(result.policies.approval_gates));
    assert.strictEqual(result.policies.approval_gates[0].phase, 'deploy');
  });
});

// -------------------------------------------------------------------
// Tests: PolicyEngine - no policies
// -------------------------------------------------------------------

describe('PolicyEngine - no policies', function () {
  let tempDir;

  before(function () {
    tempDir = createTempDir();
    // Do NOT write any policy file
  });

  after(function () {
    cleanup(tempDir);
  });

  it('should return ALLOW for all enforcement points when no policy file exists', function () {
    const engine = new PolicyEngine(tempDir);
    assert.strictEqual(engine.hasPolicies(), false);

    const result = engine.evaluate('pre_execution', { file_path: '/etc/passwd' });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.decision, 'ALLOW');
    assert.strictEqual(result.violations.length, 0);

    engine.destroy();
  });

  it('should return empty approval gates when no policies exist', function () {
    const engine = new PolicyEngine(tempDir);
    assert.deepStrictEqual(engine.getApprovalGates(), []);
    engine.destroy();
  });
});

// -------------------------------------------------------------------
// Tests: PolicyEngine - JSON loading
// -------------------------------------------------------------------

describe('PolicyEngine - JSON policies', function () {
  let tempDir;

  before(function () {
    tempDir = createTempDir();
    writePolicyJson(tempDir, {
      version: 1,
      policies: {
        pre_execution: [
          {
            name: 'sandbox-files',
            rule: 'file_path must start with project_dir',
            action: 'deny',
          },
          {
            name: 'max-agents',
            rule: 'active_agents <= 5',
            action: 'deny',
          },
        ],
        resource: [
          {
            name: 'token-budget',
            max_tokens: 100000,
            alerts: [50, 80, 100],
            on_exceed: 'shutdown',
          },
          {
            name: 'approved-providers',
            providers: ['claude', 'openai'],
            action: 'deny',
          },
        ],
        data: [
          {
            name: 'secret-scan',
            type: 'secret_detection',
            action: 'deny',
          },
        ],
        approval_gates: [
          {
            name: 'pre-deploy',
            phase: 'deploy',
            timeout_minutes: 30,
          },
        ],
      },
    });
  });

  after(function () {
    cleanup(tempDir);
  });

  it('should load JSON policies', function () {
    const engine = new PolicyEngine(tempDir);
    assert.strictEqual(engine.hasPolicies(), true);
    assert.strictEqual(engine.getValidationErrors().length, 0);
    engine.destroy();
  });

  it('should DENY file access outside project dir', function () {
    const engine = new PolicyEngine(tempDir);
    const result = engine.evaluate('pre_execution', {
      file_path: '/etc/passwd',
      project_dir: '/home/project',
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.decision, 'DENY');
    assert.ok(result.reason.includes('sandbox-files'));
    engine.destroy();
  });

  it('should ALLOW file access within project dir', function () {
    const engine = new PolicyEngine(tempDir);
    const result = engine.evaluate('pre_execution', {
      file_path: '/home/project/src/index.js',
      project_dir: '/home/project',
    });
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.decision, 'ALLOW');
    engine.destroy();
  });

  it('should DENY when agent limit exceeded', function () {
    const engine = new PolicyEngine(tempDir);
    const result = engine.evaluate('pre_execution', {
      active_agents: 10,
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.decision, 'DENY');
    assert.ok(result.reason.includes('max-agents'));
    engine.destroy();
  });

  it('should ALLOW when agent count within limit', function () {
    const engine = new PolicyEngine(tempDir);
    const result = engine.evaluate('pre_execution', {
      active_agents: 3,
    });
    assert.strictEqual(result.allowed, true);
    engine.destroy();
  });

  it('should DENY unapproved providers', function () {
    const engine = new PolicyEngine(tempDir);
    const result = engine.evaluate('resource', {
      provider: 'anthropic-direct',
    });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('approved-providers'));
    engine.destroy();
  });

  it('should ALLOW approved providers', function () {
    const engine = new PolicyEngine(tempDir);
    const result = engine.evaluate('resource', {
      provider: 'claude',
    });
    assert.strictEqual(result.allowed, true);
    engine.destroy();
  });

  it('should DENY when secrets detected in content', function () {
    const engine = new PolicyEngine(tempDir);
    const result = engine.evaluate('data', {
      content: 'const API_KEY = "sk-1234567890abcdef1234567890abcdef"',
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.decision, 'DENY');
    engine.destroy();
  });

  it('should ALLOW clean content', function () {
    const engine = new PolicyEngine(tempDir);
    const result = engine.evaluate('data', {
      content: 'const greeting = "hello world";',
    });
    assert.strictEqual(result.allowed, true);
    engine.destroy();
  });

  it('should return approval gates', function () {
    const engine = new PolicyEngine(tempDir);
    const gates = engine.getApprovalGates();
    assert.strictEqual(gates.length, 1);
    assert.strictEqual(gates[0].phase, 'deploy');
    engine.destroy();
  });

  it('should return resource policies', function () {
    const engine = new PolicyEngine(tempDir);
    const resources = engine.getResourcePolicies();
    assert.strictEqual(resources.length, 2);
    engine.destroy();
  });
});

// -------------------------------------------------------------------
// Tests: PolicyEngine - YAML loading
// -------------------------------------------------------------------

describe('PolicyEngine - YAML policies', function () {
  let tempDir;

  before(function () {
    tempDir = createTempDir();
    writePolicyYaml(tempDir, [
      'version: 1',
      'policies:',
      '  pre_execution:',
      '    - name: sandbox-files',
      '      rule: "file_path must start with project_dir"',
      '      action: deny',
      '  resource:',
      '    - name: approved-providers',
      '      providers: [claude, openai]',
      '      action: deny',
    ].join('\n'));
  });

  after(function () {
    cleanup(tempDir);
  });

  it('should load YAML policies as fallback', function () {
    const engine = new PolicyEngine(tempDir);
    assert.strictEqual(engine.hasPolicies(), true);
    engine.destroy();
  });

  it('should evaluate YAML-loaded policies', function () {
    const engine = new PolicyEngine(tempDir);
    const result = engine.evaluate('pre_execution', {
      file_path: '/etc/passwd',
      project_dir: '/home/project',
    });
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.decision, 'DENY');
    engine.destroy();
  });
});

// -------------------------------------------------------------------
// Tests: PolicyEngine - caching and reload
// -------------------------------------------------------------------

describe('PolicyEngine - reload', function () {
  let tempDir;

  before(function () {
    tempDir = createTempDir();
    writePolicyJson(tempDir, {
      version: 1,
      policies: {
        resource: [
          { name: 'approved-providers', providers: ['claude'], action: 'deny' },
        ],
      },
    });
  });

  after(function () {
    cleanup(tempDir);
  });

  it('should reload policies when reload() is called', function () {
    const engine = new PolicyEngine(tempDir);

    // Initially, only claude is approved
    let result = engine.evaluate('resource', { provider: 'openai' });
    assert.strictEqual(result.allowed, false);

    // Update policy file to also allow openai
    writePolicyJson(tempDir, {
      version: 1,
      policies: {
        resource: [
          { name: 'approved-providers', providers: ['claude', 'openai'], action: 'deny' },
        ],
      },
    });

    engine.reload();

    result = engine.evaluate('resource', { provider: 'openai' });
    assert.strictEqual(result.allowed, true);

    engine.destroy();
  });
});

// -------------------------------------------------------------------
// Tests: PolicyEngine - performance
// -------------------------------------------------------------------

describe('PolicyEngine - performance', function () {
  let tempDir;

  before(function () {
    tempDir = createTempDir();
    writePolicyJson(tempDir, {
      version: 1,
      policies: {
        pre_execution: [
          { name: 'sandbox', rule: 'file_path must start with project_dir', action: 'deny' },
          { name: 'agents', rule: 'active_agents <= 10', action: 'deny' },
        ],
        resource: [
          { name: 'budget', max_tokens: 1000000, alerts: [50, 80, 100], on_exceed: 'shutdown' },
          { name: 'providers', providers: ['claude', 'openai'], action: 'deny' },
        ],
        data: [
          { name: 'secrets', type: 'secret_detection', action: 'deny' },
        ],
      },
    });
  });

  after(function () {
    cleanup(tempDir);
  });

  it('should evaluate policies in under 10ms', function () {
    const engine = new PolicyEngine(tempDir);
    const iterations = 1000;
    const context = {
      file_path: '/home/project/src/index.js',
      project_dir: '/home/project',
      active_agents: 3,
    };

    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      engine.evaluate('pre_execution', context);
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms
    const perEval = elapsed / iterations;

    assert.ok(perEval < 10, 'Average evaluation time ' + perEval.toFixed(3) + 'ms exceeds 10ms limit');
    engine.destroy();
  });
});

// -------------------------------------------------------------------
// Tests: PolicyEngine - unknown enforcement point
// -------------------------------------------------------------------

describe('PolicyEngine - edge cases', function () {
  let tempDir;

  before(function () {
    tempDir = createTempDir();
    writePolicyJson(tempDir, { version: 1, policies: {} });
  });

  after(function () {
    cleanup(tempDir);
  });

  it('should return ALLOW for unknown enforcement points', function () {
    const engine = new PolicyEngine(tempDir);
    const result = engine.evaluate('unknown_point', {});
    assert.strictEqual(result.allowed, true);
    engine.destroy();
  });

  it('should handle null context gracefully', function () {
    const engine = new PolicyEngine(tempDir);
    const result = engine.evaluate('pre_execution', null);
    assert.strictEqual(result.allowed, true);
    engine.destroy();
  });
});

// -------------------------------------------------------------------
// Tests: PolicyEngine - pre_deployment
// -------------------------------------------------------------------

describe('PolicyEngine - pre_deployment', function () {
  let tempDir;

  before(function () {
    tempDir = createTempDir();
    writePolicyJson(tempDir, {
      version: 1,
      policies: {
        pre_deployment: [
          {
            name: 'quality-gates',
            gates: ['static-analysis', 'test-coverage', 'security-scan'],
            action: 'deny',
          },
        ],
      },
    });
  });

  after(function () {
    cleanup(tempDir);
  });

  it('should DENY when required gates not passed', function () {
    const engine = new PolicyEngine(tempDir);
    const result = engine.evaluate('pre_deployment', {
      passed_gates: ['static-analysis'],
    });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.includes('test-coverage'));
    engine.destroy();
  });

  it('should ALLOW when all required gates passed', function () {
    const engine = new PolicyEngine(tempDir);
    const result = engine.evaluate('pre_deployment', {
      passed_gates: ['static-analysis', 'test-coverage', 'security-scan'],
    });
    assert.strictEqual(result.allowed, true);
    engine.destroy();
  });
});

// -------------------------------------------------------------------
// Tests: Unknown rule validation warning (Finding 8 fix)
// -------------------------------------------------------------------

describe('PolicyEngine - unknown rule validation warning', function () {
  let tempDir;

  before(function () {
    tempDir = createTempDir();
  });

  after(function () {
    cleanup(tempDir);
  });

  it('should add warning to validation errors for unrecognized rule strings', function () {
    writePolicyJson(tempDir, {
      pre_execution: [
        { name: 'good-rule', rule: 'file_path must start with project_dir', action: 'deny' },
        // Completely different rule name that doesn't match any known evaluator prefix
        { name: 'typo-rule', rule: 'restrict_file_access to project_dir', action: 'deny' },
      ],
    });
    const engine = new PolicyEngine(tempDir);
    const errors = engine.getValidationErrors();
    assert.ok(
      errors.some(function (e) { return e.includes('not recognized') && e.includes('restrict_file_access'); }),
      'Should warn about unrecognized rule: ' + JSON.stringify(errors)
    );
    engine.destroy();
  });

  it('should not warn for recognized rule strings', function () {
    writePolicyJson(tempDir, {
      pre_execution: [
        { name: 'file-rule', rule: 'file_path must start with project_dir', action: 'deny' },
        { name: 'agent-rule', rule: 'active_agents <= 5', action: 'deny' },
      ],
    });
    const engine = new PolicyEngine(tempDir);
    const errors = engine.getValidationErrors();
    assert.ok(
      !errors.some(function (e) { return e.includes('not recognized'); }),
      'Known rules should not produce warnings: ' + JSON.stringify(errors)
    );
    engine.destroy();
  });
});

describe('PolicyEngine - autonomy ladder', function () {
  function engineWith(doc) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loki-autonomy-'));
    fs.mkdirSync(path.join(dir, '.loki'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.loki', 'policies.json'), JSON.stringify(doc));
    return new PolicyEngine(dir);
  }
  it('allowedActions maps levels', function () {
    const { allowedActions } = require('../../src/policies/engine');
    assert.deepStrictEqual(allowedActions('propose'), { pr: false, merge: false, deploy: false });
    assert.deepStrictEqual(allowedActions('execute'), { pr: true, merge: false, deploy: false });
    assert.deepStrictEqual(allowedActions('operate'), { pr: true, merge: false, deploy: true });
    assert.strictEqual(allowedActions('bogus'), null);
  });
  it('propose denies pr, execute allows pr but not deploy, operate allows both', function () {
    assert.strictEqual(engineWith({ autonomy: 'propose' }).evaluate('pre_deployment', { action: 'pr' }).decision, 'DENY');
    const ex = engineWith({ autonomy: 'execute' });
    assert.strictEqual(ex.evaluate('pre_deployment', { action: 'pr' }).decision, 'ALLOW');
    assert.strictEqual(ex.evaluate('pre_deployment', { action: 'deploy' }).decision, 'DENY');
    assert.strictEqual(engineWith({ autonomy: 'operate' }).evaluate('pre_deployment', { action: 'deploy' }).decision, 'ALLOW');
  });
  it('actions override can require approval', function () {
    const r = engineWith({ autonomy: 'execute', actions: { pr: 'require_approval' } }).evaluate('pre_deployment', { action: 'pr' });
    assert.strictEqual(r.decision, 'REQUIRE_APPROVAL');
    assert.strictEqual(r.requiresApproval, true);
  });
  it('unknown autonomy level fails closed and is reported', function () {
    const e = engineWith({ autonomy: 'yolo' });
    assert.strictEqual(e.evaluate('pre_deployment', { action: 'pr' }).decision, 'DENY');
    assert.ok(e.getValidationErrors().some(function (m) { return m.includes('autonomy'); }));
  });
  it('no autonomy key leaves behaviour unchanged', function () {
    assert.strictEqual(engineWith({ pre_deployment: [] }).evaluate('pre_deployment', { action: 'pr' }).decision, 'ALLOW');
  });
});
