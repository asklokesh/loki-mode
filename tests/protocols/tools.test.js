'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { handleRequest } = require('../../src/protocols/mcp-server');

let testDir;
const origCwd = process.cwd();

before(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-test-'));
  process.chdir(testDir);
});

after(() => {
  process.chdir(origCwd);
  fs.rmSync(testDir, { recursive: true, force: true });
});

function callTool(name, args, id) {
  return handleRequest({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: name, arguments: args || {} },
    id: id || 1
  });
}

function parseToolResult(response) {
  assert.ok(response.result, 'Expected result in response');
  assert.ok(response.result.content, 'Expected content in result');
  const body = JSON.parse(response.result.content[0].text);
  // Flatten the untrusted envelope so these tests read the same fields; the
  // envelope itself is asserted in mcp-server.test.js.
  const { untrusted_content: stored, untrusted, notice, ...rest } = body;
  return { ...rest, ...stored };
}

// -------------------------------------------------------------------
// loki/start-project
// -------------------------------------------------------------------
describe('loki/start-project', () => {
  beforeEach(() => {
    // Clean up any existing session to avoid session guard blocking
    const sessionPath = path.join(testDir, '.loki', 'state', 'session.json');
    if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
  });
  it('should start a project with inline PRD', () => {
    const resp = callTool('loki/start-project', {
      prd: 'Build a SaaS product for task management with real-time collaboration.'
    });
    const result = parseToolResult(resp);
    assert.ok(result.success);
    assert.ok(result.projectId);
    assert.ok(result.projectId.startsWith('proj-'));
    assert.equal(result.provider, 'claude');
    assert.equal(result.phase, 'discovery');
    assert.equal(result.status, 'running');
  });

  it('should start a project with specified provider', () => {
    const resp = callTool('loki/start-project', {
      prd: 'Build a CLI tool.',
      provider: 'codex'
    });
    const result = parseToolResult(resp);
    assert.ok(result.success);
    assert.equal(result.provider, 'codex');
  });

  it('should reject empty PRD', () => {
    const resp = callTool('loki/start-project', { prd: '' });
    const result = parseToolResult(resp);
    assert.equal(result.success, false);
    assert.ok(result.error);
  });

  it('should create .loki directory structure', () => {
    callTool('loki/start-project', { prd: 'Test project.' });
    assert.ok(fs.existsSync(path.join(testDir, '.loki', 'state', 'session.json')));
    assert.ok(fs.existsSync(path.join(testDir, '.loki', 'state', 'orchestrator.json')));
  });

  it('should read PRD from file path', () => {
    const prdPath = path.join(testDir, 'test-prd.md');
    fs.writeFileSync(prdPath, '# My PRD\n\nBuild something great.', 'utf8');
    const resp = callTool('loki/start-project', { prd: prdPath });
    const result = parseToolResult(resp);
    assert.ok(result.success);
    assert.equal(result.prdSource, prdPath);
    assert.ok(result.prdLength > 10);
  });
});

// -------------------------------------------------------------------
// loki/project-status
// -------------------------------------------------------------------
describe('loki/project-status', () => {
  beforeEach(() => {
    // Ensure a project is running
    callTool('loki/start-project', { prd: 'Status test project.' });
  });

  it('should return current status', () => {
    const resp = callTool('loki/project-status', {});
    const result = parseToolResult(resp);
    assert.ok(result.success);
    assert.ok(result.projectId);
    assert.equal(result.phase, 'discovery');
    assert.equal(result.status, 'running');
  });

  it('should include task summary', () => {
    const resp = callTool('loki/project-status', {});
    const result = parseToolResult(resp);
    assert.ok(result.tasks !== undefined);
    assert.equal(typeof result.tasks.total, 'number');
  });

  it('should detect PAUSE signal', () => {
    const lokiDir = path.join(testDir, '.loki');
    fs.writeFileSync(path.join(lokiDir, 'PAUSE'), '', 'utf8');
    const resp = callTool('loki/project-status', {});
    const result = parseToolResult(resp);
    assert.equal(result.status, 'paused');
    fs.unlinkSync(path.join(lokiDir, 'PAUSE'));
  });

  it('should detect STOP signal', () => {
    const lokiDir = path.join(testDir, '.loki');
    fs.writeFileSync(path.join(lokiDir, 'STOP'), '', 'utf8');
    const resp = callTool('loki/project-status', {});
    const result = parseToolResult(resp);
    assert.equal(result.status, 'stopped');
    fs.unlinkSync(path.join(lokiDir, 'STOP'));
  });
});

// -------------------------------------------------------------------
// loki/agent-metrics
// -------------------------------------------------------------------
describe('loki/agent-metrics', () => {
  it('should return metrics in JSON format', () => {
    callTool('loki/start-project', { prd: 'Metrics test.' });
    const resp = callTool('loki/agent-metrics', {});
    const result = parseToolResult(resp);
    assert.ok(result.success);
    assert.ok(result.metrics);
    assert.equal(typeof result.metrics.rarvCycles, 'number');
    assert.equal(typeof result.metrics.toolCalls, 'number');
    assert.ok(result.metrics.timestamp);
  });

  it('should return metrics in Prometheus format', () => {
    const resp = callTool('loki/agent-metrics', { format: 'prometheus' });
    const result = parseToolResult(resp);
    assert.ok(result.success);
    assert.equal(result.contentType, 'text/plain');
    assert.ok(result.body.includes('loki_rarv_cycles_total'));
    assert.ok(result.body.includes('loki_tasks_completed_total'));
    assert.ok(result.body.includes('# HELP'));
    assert.ok(result.body.includes('# TYPE'));
  });

  it('should read tool usage from metrics file', () => {
    const metricsDir = path.join(testDir, '.loki', 'metrics');
    fs.mkdirSync(metricsDir, { recursive: true });
    const entries = [
      JSON.stringify({ tool: 'grep', timestamp: new Date().toISOString() }),
      JSON.stringify({ tool: 'read', timestamp: new Date().toISOString() }),
      JSON.stringify({ tool: 'grep', timestamp: new Date().toISOString() })
    ];
    fs.writeFileSync(path.join(metricsDir, 'tool-usage.jsonl'), entries.join('\n'), 'utf8');

    const resp = callTool('loki/agent-metrics', {});
    const result = parseToolResult(resp);
    assert.equal(result.metrics.toolCalls, 3);
    assert.equal(result.metrics.toolBreakdown.grep, 2);
    assert.equal(result.metrics.toolBreakdown.read, 1);
  });
});

// -------------------------------------------------------------------
// loki/checkpoint-restore
// -------------------------------------------------------------------
describe('loki/checkpoint-restore', () => {
  beforeEach(() => {
    callTool('loki/start-project', { prd: 'Checkpoint test.' });
  });

  it('should list checkpoints (empty initially)', () => {
    const resp = callTool('loki/checkpoint-restore', { action: 'list' });
    const result = parseToolResult(resp);
    assert.ok(result.success);
    assert.ok(Array.isArray(result.checkpoints));
  });

  it('should create a checkpoint', () => {
    const resp = callTool('loki/checkpoint-restore', {
      action: 'create',
      label: 'after-discovery'
    });
    const result = parseToolResult(resp);
    assert.ok(result.success);
    assert.ok(result.checkpointId);
    assert.ok(result.checkpointId.startsWith('chk-'));
    assert.equal(result.label, 'after-discovery');
    assert.ok(result.stateFiles > 0);
  });

  it('should restore from a checkpoint', () => {
    // Create checkpoint
    const createResp = callTool('loki/checkpoint-restore', {
      action: 'create',
      label: 'before-change'
    });
    const createResult = parseToolResult(createResp);
    const checkpointId = createResult.checkpointId;

    // Modify state
    const orchPath = path.join(testDir, '.loki', 'state', 'orchestrator.json');
    const orch = JSON.parse(fs.readFileSync(orchPath, 'utf8'));
    orch.currentPhase = 'deployment';
    fs.writeFileSync(orchPath, JSON.stringify(orch), 'utf8');

    // Restore
    const restoreResp = callTool('loki/checkpoint-restore', {
      action: 'restore',
      checkpointId: checkpointId
    });
    const restoreResult = parseToolResult(restoreResp);
    assert.ok(restoreResult.success);
    assert.ok(restoreResult.restoredCount > 0);

    // Verify state was restored
    const restoredOrch = JSON.parse(fs.readFileSync(orchPath, 'utf8'));
    assert.equal(restoredOrch.currentPhase, 'discovery');
  });

  it('should fail to restore non-existent checkpoint', () => {
    const resp = callTool('loki/checkpoint-restore', {
      action: 'restore',
      checkpointId: 'chk-00000000'
    });
    const result = parseToolResult(resp);
    assert.equal(result.success, false);
  });

  it('should reject checkpoint IDs with path traversal characters', () => {
    const resp = callTool('loki/checkpoint-restore', {
      action: 'restore',
      checkpointId: '../../.loki/state/session'
    });
    const result = parseToolResult(resp);
    assert.equal(result.success, false);
    assert.ok(result.error.includes('Invalid checkpoint ID'));
  });

  it('should reject checkpoint IDs that do not match expected format', () => {
    const resp = callTool('loki/checkpoint-restore', {
      action: 'restore',
      checkpointId: 'chk-GGGGGGGG'
    });
    const result = parseToolResult(resp);
    assert.equal(result.success, false);
    assert.ok(result.error.includes('Invalid checkpoint ID'));
  });

  it('should require checkpointId for restore', () => {
    const resp = callTool('loki/checkpoint-restore', { action: 'restore' });
    const result = parseToolResult(resp);
    assert.equal(result.success, false);
    assert.ok(result.error.includes('checkpointId'));
  });
});

// -------------------------------------------------------------------
// loki/quality-report
// -------------------------------------------------------------------
describe('loki/quality-report', () => {
  it('should return NO_DATA when no quality gates exist', () => {
    const resp = callTool('loki/quality-report', {});
    const result = parseToolResult(resp);
    assert.ok(result.success);
    assert.equal(result.verdict, 'NO_DATA');
    assert.deepEqual(result.blocking, []);
  });

  it('should report quality gate results', () => {
    const stateDir = path.join(testDir, '.loki', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const gates = {
      results: [
        { name: 'static-analysis', passed: true, severity: 'high' },
        { name: 'test-coverage', passed: false, severity: 'critical', message: 'Coverage 65%' },
        { name: 'linting', passed: true, severity: 'medium' }
      ]
    };
    fs.writeFileSync(path.join(stateDir, 'quality-gates.json'), JSON.stringify(gates), 'utf8');

    const resp = callTool('loki/quality-report', {});
    const result = parseToolResult(resp);
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.summary.total, 3);
    assert.equal(result.summary.passed, 2);
    assert.equal(result.summary.failed, 1);
    assert.ok(result.blocking.includes('test-coverage'));
  });

  it('should filter by specific gate', () => {
    const resp = callTool('loki/quality-report', { gate: 'linting' });
    const result = parseToolResult(resp);
    assert.equal(result.gates.length, 1);
    assert.equal(result.gates[0].name, 'linting');
  });

  it('should include blind review data when present', () => {
    const stateDir = path.join(testDir, '.loki', 'state');
    const review = {
      reviewers: ['opus-1', 'opus-2', 'opus-3'],
      averageScore: 8.5,
      consensus: 'approve',
      unanimous: true
    };
    fs.writeFileSync(path.join(stateDir, 'blind-review.json'), JSON.stringify(review), 'utf8');

    const resp = callTool('loki/quality-report', {});
    const result = parseToolResult(resp);
    assert.ok(result.blindReview);
    assert.equal(result.blindReview.averageScore, 8.5);
    assert.equal(result.blindReview.unanimous, true);
  });

  it('should include council votes when present', () => {
    const stateDir = path.join(testDir, '.loki', 'state');
    const council = {
      votes: [{ agent: 'opus-1', vote: 'approve' }],
      decision: 'approved',
      devilsAdvocateTriggered: false
    };
    fs.writeFileSync(path.join(stateDir, 'council-votes.json'), JSON.stringify(council), 'utf8');

    const resp = callTool('loki/quality-report', {});
    const result = parseToolResult(resp);
    assert.ok(result.councilVotes);
    assert.equal(result.councilVotes.decision, 'approved');
  });
});
