'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var handler = require('../../../src/integrations/github/action-handler.js');

// ============================================================
// parseTriggerContext
// ============================================================

test('parseTriggerContext - issue labeled event extracts PRD from body', function () {
  var payload = {
    action: 'labeled',
    label: { name: 'loki-mode' },
    issue: {
      number: 42,
      title: 'Build auth system',
      body: 'Please implement the following:\n\n## PRD\n\nBuild a JWT-based auth system with login and signup.\n\n## Notes\n\nUse bcrypt for passwords.',
      html_url: 'https://github.com/org/repo/issues/42',
      user: { login: 'testuser' },
      labels: [{ name: 'loki-mode' }, { name: 'enhancement' }],
    },
    repository: { full_name: 'org/repo' },
  };

  var ctx = handler.parseTriggerContext({ eventName: 'issues', payload: payload });

  assert.equal(ctx.triggerType, 'issue');
  assert.equal(ctx.sourceType, 'issue');
  assert.equal(ctx.sourceId, '42');
  assert.equal(ctx.provider, 'claude');
  assert.equal(ctx.dryRun, false);
  assert.equal(ctx.prd, 'Build a JWT-based auth system with login and signup.');
  assert.equal(ctx.metadata.issueNumber, 42);
  assert.equal(ctx.metadata.issueTitle, 'Build auth system');
  assert.equal(ctx.metadata.triggerLabel, 'loki-mode');
});

test('parseTriggerContext - issue with PRD comment markers', function () {
  var payload = {
    label: { name: 'loki-mode' },
    issue: {
      number: 10,
      body: 'Some intro text\n<!-- PRD_START -->\nThis is the PRD content.\nMultiple lines.\n<!-- PRD_END -->\nMore text after.',
      labels: [{ name: 'loki-mode' }],
      user: {},
    },
    repository: { full_name: 'org/repo' },
  };

  var ctx = handler.parseTriggerContext({ eventName: 'issues', payload: payload });
  assert.equal(ctx.prd, 'This is the PRD content.\nMultiple lines.');
});

test('parseTriggerContext - issue with fenced prd code block', function () {
  var payload = {
    label: { name: 'loki-mode' },
    issue: {
      number: 11,
      body: 'Some intro\n```prd\nFenced PRD content here\n```\nAfter block',
      labels: [{ name: 'loki-mode' }],
      user: {},
    },
    repository: { full_name: 'org/repo' },
  };

  var ctx = handler.parseTriggerContext({ eventName: 'issues', payload: payload });
  assert.equal(ctx.prd, 'Fenced PRD content here');
});

test('parseTriggerContext - issue with no markers uses full body', function () {
  var payload = {
    label: { name: 'loki-mode' },
    issue: {
      number: 12,
      body: 'Just a plain issue body with no markers.',
      labels: [{ name: 'loki-mode' }],
      user: {},
    },
    repository: { full_name: 'org/repo' },
  };

  var ctx = handler.parseTriggerContext({ eventName: 'issues', payload: payload });
  assert.equal(ctx.prd, 'Just a plain issue body with no markers.');
});

test('parseTriggerContext - issue with empty body', function () {
  var payload = {
    label: { name: 'loki-mode' },
    issue: {
      number: 13,
      body: '',
      labels: [],
      user: {},
    },
    repository: { full_name: 'org/repo' },
  };

  var ctx = handler.parseTriggerContext({ eventName: 'issues', payload: payload });
  assert.equal(ctx.prd, '');
});

// ============================================================
// pull_request_review event
// ============================================================

test('parseTriggerContext - PR review event extracts context', function () {
  var payload = {
    action: 'submitted',
    review: {
      state: 'approved',
      user: { login: 'reviewer1' },
    },
    pull_request: {
      number: 99,
      title: 'Add payment processing',
      body: '## PRD\n\nIntegrate Stripe payment processing.\n\n## Implementation\n\nUse stripe-node SDK.',
      html_url: 'https://github.com/org/repo/pull/99',
      head: { ref: 'feature/payments' },
      base: { ref: 'main' },
      user: { login: 'author1' },
      labels: [{ name: 'loki-mode' }],
    },
    repository: { full_name: 'org/repo' },
  };

  var ctx = handler.parseTriggerContext({ eventName: 'pull_request_review', payload: payload });

  assert.equal(ctx.triggerType, 'pull_request_review');
  assert.equal(ctx.sourceType, 'pull_request');
  assert.equal(ctx.sourceId, '99');
  assert.equal(ctx.prd, 'Integrate Stripe payment processing.');
  assert.equal(ctx.metadata.prNumber, 99);
  assert.equal(ctx.metadata.prHead, 'feature/payments');
  assert.equal(ctx.metadata.prBase, 'main');
  assert.equal(ctx.metadata.reviewState, 'approved');
  assert.equal(ctx.metadata.reviewAuthor, 'reviewer1');
});

// ============================================================
// workflow_dispatch event
// ============================================================

test('parseTriggerContext - workflow_dispatch with PRD input', function () {
  var payload = {
    sender: { login: 'deployer' },
    repository: { full_name: 'org/repo' },
  };
  var inputs = {
    prd_content: 'Build a CLI tool that does X, Y, Z.',
    provider: 'codex',
    dry_run: 'true',
  };

  var ctx = handler.parseTriggerContext({
    eventName: 'workflow_dispatch',
    payload: payload,
    inputs: inputs,
  });

  assert.equal(ctx.triggerType, 'workflow_dispatch');
  assert.equal(ctx.prd, 'Build a CLI tool that does X, Y, Z.');
  assert.equal(ctx.provider, 'codex');
  assert.equal(ctx.dryRun, true);
  assert.equal(ctx.sourceId, null);
  assert.equal(ctx.metadata.sender, 'deployer');
});

test('parseTriggerContext - workflow_dispatch with boolean dry_run', function () {
  var payload = { sender: {}, repository: { full_name: 'org/repo' } };
  // v7.5.18: gemini removed; use aider instead.
  var inputs = { prd_content: 'test', provider: 'aider', dry_run: true };

  var ctx = handler.parseTriggerContext({
    eventName: 'workflow_dispatch',
    payload: payload,
    inputs: inputs,
  });

  assert.equal(ctx.dryRun, true);
  assert.equal(ctx.provider, 'aider');
});

// ============================================================
// schedule event
// ============================================================

test('parseTriggerContext - schedule event', function () {
  var payload = {
    schedule: '0 6 * * 1',
    repository: { full_name: 'org/repo' },
  };

  var ctx = handler.parseTriggerContext({ eventName: 'schedule', payload: payload });

  assert.equal(ctx.triggerType, 'schedule');
  assert.equal(ctx.prd, '');
  assert.equal(ctx.provider, 'claude');
  assert.equal(ctx.sourceId, null);
});

// ============================================================
// unknown event
// ============================================================

test('parseTriggerContext - unknown event returns safe defaults', function () {
  var ctx = handler.parseTriggerContext({
    eventName: 'deployment',
    payload: {},
  });

  assert.equal(ctx.triggerType, 'unknown');
  assert.equal(ctx.prd, '');
  assert.equal(ctx.provider, 'claude');
});

// ============================================================
// mapLabelsToConfig
// ============================================================

test('mapLabelsToConfig - maps known labels to config', function () {
  var config = handler.mapLabelsToConfig(['loki-mode', 'loki-provider-codex', 'loki-dry-run']);

  assert.equal(config.enabled, true);
  assert.equal(config.provider, 'codex');
  assert.equal(config.dryRun, true);
});

test('mapLabelsToConfig - ignores unknown labels', function () {
  var config = handler.mapLabelsToConfig(['bug', 'enhancement', 'loki-mode']);

  assert.equal(config.enabled, true);
  assert.equal(config.provider, undefined);
});

test('mapLabelsToConfig - handles empty array', function () {
  var config = handler.mapLabelsToConfig([]);
  assert.deepEqual(config, {});
});

test('mapLabelsToConfig - handles non-array input', function () {
  var config = handler.mapLabelsToConfig(null);
  assert.deepEqual(config, {});
});

// ============================================================
// extractPrdFromBody
// ============================================================

test('extractPrdFromBody - handles null/undefined', function () {
  assert.equal(handler.extractPrdFromBody(null), '');
  assert.equal(handler.extractPrdFromBody(undefined), '');
  assert.equal(handler.extractPrdFromBody(''), '');
});

test('extractPrdFromBody - prefers HTML comment markers', function () {
  var body = 'Intro\n<!-- PRD_START -->\nMarker content\n<!-- PRD_END -->\n```prd\nCode content\n```';
  assert.equal(handler.extractPrdFromBody(body), 'Marker content');
});

test('extractPrdFromBody - falls back to code block', function () {
  var body = 'Intro\n```prd\nCode block content\n```\nMore text';
  assert.equal(handler.extractPrdFromBody(body), 'Code block content');
});

test('extractPrdFromBody - falls back to section header', function () {
  var body = '## PRD\n\nSection content here\n\n## Other\n\nNot this';
  assert.equal(handler.extractPrdFromBody(body), 'Section content here');
});

// ============================================================
// issue label to provider mapping
// ============================================================

test('issue with provider label overrides default', function () {
  var payload = {
    label: { name: 'loki-mode' },
    issue: {
      number: 50,
      body: 'Test body',
      // v7.5.18: gemini removed; use loki-provider-codex.
      labels: [{ name: 'loki-mode' }, { name: 'loki-provider-codex' }],
      user: {},
    },
    repository: { full_name: 'org/repo' },
  };

  var ctx = handler.parseTriggerContext({ eventName: 'issues', payload: payload });
  assert.equal(ctx.provider, 'codex');
});

test('issue with priority label sets config', function () {
  var config = handler.mapLabelsToConfig(['loki-mode', 'loki-priority-high']);
  assert.equal(config.priority, 'high');
});

// ============================================================
// Provider validation in workflow_dispatch (security fix)
// ============================================================

test('parseWorkflowDispatchEvent - valid provider is passed through', function () {
  var payload = { sender: { login: 'user' }, repository: { full_name: 'org/repo' } };

  var ctx1 = handler.parseTriggerContext({ eventName: 'workflow_dispatch', payload: payload, inputs: { prd_content: 'x', provider: 'claude' } });
  assert.equal(ctx1.provider, 'claude');

  var ctx2 = handler.parseTriggerContext({ eventName: 'workflow_dispatch', payload: payload, inputs: { prd_content: 'x', provider: 'codex' } });
  assert.equal(ctx2.provider, 'codex');

  // v7.5.18: gemini removed; use aider as the third valid provider.
  var ctx3 = handler.parseTriggerContext({ eventName: 'workflow_dispatch', payload: payload, inputs: { prd_content: 'x', provider: 'aider' } });
  assert.equal(ctx3.provider, 'aider');
});

test('parseWorkflowDispatchEvent - invalid provider falls back to claude', function () {
  var payload = { sender: { login: 'user' }, repository: { full_name: 'org/repo' } };

  // Simulate REST API bypassing the choice constraint with shell metacharacters
  var ctx = handler.parseTriggerContext({
    eventName: 'workflow_dispatch',
    payload: payload,
    inputs: { prd_content: 'x', provider: '; rm -rf /' },
  });
  assert.equal(ctx.provider, 'claude');
});

test('parseWorkflowDispatchEvent - unknown provider string falls back to claude', function () {
  var payload = { sender: {}, repository: { full_name: 'org/repo' } };
  var ctx = handler.parseTriggerContext({
    eventName: 'workflow_dispatch',
    payload: payload,
    inputs: { prd_content: 'x', provider: 'gpt-9000' },
  });
  assert.equal(ctx.provider, 'claude');
});

// v7.5.18: gemini removed from ALLOWED_PROVIDERS. Now claude, codex, cline, aider.
test('ALLOWED_PROVIDERS contains exactly claude, codex, cline, aider', function () {
  assert.deepEqual(handler.ALLOWED_PROVIDERS, ['claude', 'codex', 'cline', 'aider']);
});

// ============================================================
// PRD section regex edge case (correctness fix)
// ============================================================

test('extractPrdFromBody - section regex captures multi-paragraph PRD correctly', function () {
  // Reproduces the bug where /m flag caused $ to match end-of-line,
  // stopping at the first blank line instead of the next ## heading.
  var body = '## PRD\n\nLine one\nLine two\n\nLine three after blank\n\n## Next Heading\nOther stuff';
  var result = handler.extractPrdFromBody(body);
  assert.ok(result.indexOf('Line one') !== -1, 'Should include line one');
  assert.ok(result.indexOf('Line two') !== -1, 'Should include line two');
  assert.ok(result.indexOf('Line three after blank') !== -1, 'Should include content after blank line');
  assert.ok(result.indexOf('Next Heading') === -1, 'Should not include next heading');
  assert.ok(result.indexOf('Other stuff') === -1, 'Should not include content after next heading');
});
