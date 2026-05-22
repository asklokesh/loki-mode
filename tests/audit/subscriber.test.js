'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var subscriber = require('../../src/audit/subscriber');

function makeTempDir() {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-sub-test-'));
    return dir;
}

function createMockAudit() {
    return {
        entries: [],
        record: function(entry) { this.entries.push(entry); },
        flush: function() {},
    };
}

function writeEvent(dir, filename, data) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(data), 'utf8');
}

function makeEvent(type, payload, source) {
    return {
        id: 'evt-' + Math.random().toString(36).slice(2, 8),
        type: type,
        source: source || 'test',
        timestamp: new Date().toISOString(),
        payload: payload || {},
        version: '1.0',
    };
}

test('known event types produce correct audit entries', function() {
    var tmpDir = makeTempDir();
    var mock = createMockAudit();
    subscriber._setAudit(mock);
    subscriber._setPendingDir(tmpDir);

    var knownTypes = [
        { type: 'iteration_start', expectedWhat: 'iteration_start', expectedWhy: 'RARV cycle iteration started' },
        { type: 'iteration_complete', expectedWhat: 'iteration_complete', expectedWhy: 'RARV cycle iteration completed' },
        { type: 'session_start', expectedWhat: 'session_start', expectedWhy: 'Loki session initialized' },
        { type: 'session_end', expectedWhat: 'session_end', expectedWhy: 'Loki session terminated' },
        { type: 'phase_change', expectedWhat: 'phase_change', expectedWhy: 'RARV phase transition' },
    ];

    for (var i = 0; i < knownTypes.length; i++) {
        var kt = knownTypes[i];
        var evt = makeEvent(kt.type, { iteration: '3', provider: 'claude' });
        writeEvent(tmpDir, 'evt-' + i + '.json', evt);
    }

    subscriber._resetState();
    subscriber.scanPendingEvents();

    assert.strictEqual(mock.entries.length, knownTypes.length);
    for (var j = 0; j < knownTypes.length; j++) {
        assert.strictEqual(mock.entries[j].what, knownTypes[j].expectedWhat);
        assert.strictEqual(mock.entries[j].why, knownTypes[j].expectedWhy);
        assert.strictEqual(mock.entries[j].who, 'claude');
        assert.strictEqual(mock.entries[j].where, 'iteration:3');
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('OTEL events are skipped', function() {
    var tmpDir = makeTempDir();
    var mock = createMockAudit();
    subscriber._setAudit(mock);
    subscriber._setPendingDir(tmpDir);

    writeEvent(tmpDir, 'otel1.json', makeEvent('otel_span_start', { span: 'test' }));
    writeEvent(tmpDir, 'otel2.json', makeEvent('otel_span_end', { span: 'test' }));

    subscriber._resetState();
    subscriber.scanPendingEvents();

    assert.strictEqual(mock.entries.length, 0, 'OTEL events should produce no audit entries');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('unknown event types get generic audit entry', function() {
    var tmpDir = makeTempDir();
    var mock = createMockAudit();
    subscriber._setAudit(mock);
    subscriber._setPendingDir(tmpDir);

    // v7.5.18: gemini removed; use aider as the test provider here.
    writeEvent(tmpDir, 'custom.json', makeEvent('custom_action', { foo: 'bar', provider: 'aider' }, 'agent-x'));

    subscriber._resetState();
    subscriber.scanPendingEvents();

    assert.strictEqual(mock.entries.length, 1);
    assert.strictEqual(mock.entries[0].what, 'custom_action');
    assert.strictEqual(mock.entries[0].why, 'Event recorded');
    assert.strictEqual(mock.entries[0].who, 'aider');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('malformed JSON files are handled gracefully', function() {
    var tmpDir = makeTempDir();
    var mock = createMockAudit();
    subscriber._setAudit(mock);
    subscriber._setPendingDir(tmpDir);

    fs.writeFileSync(path.join(tmpDir, 'bad.json'), '{ broken json !!!', 'utf8');

    subscriber._resetState();
    // Should not throw
    subscriber.scanPendingEvents();
    assert.strictEqual(mock.entries.length, 0, 'Malformed JSON should not produce entries');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('missing pending directory is handled gracefully', function() {
    var mock = createMockAudit();
    subscriber._setAudit(mock);
    subscriber._setPendingDir('/tmp/nonexistent-audit-test-dir-' + Date.now());

    // Should not throw
    subscriber._resetState();
    subscriber.scanPendingEvents();
    assert.strictEqual(mock.entries.length, 0);
});

test('processedFiles dedup prevents double-processing', function() {
    var tmpDir = makeTempDir();
    var mock = createMockAudit();
    subscriber._setAudit(mock);
    subscriber._setPendingDir(tmpDir);

    writeEvent(tmpDir, 'dup.json', makeEvent('session_start', { provider: 'claude' }));

    subscriber._resetState();
    subscriber.scanPendingEvents();
    assert.strictEqual(mock.entries.length, 1);

    // Scan again -- same file should not be processed again
    subscriber.scanPendingEvents();
    assert.strictEqual(mock.entries.length, 1, 'Duplicate scan should not produce new entries');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('audit entries have correct who/what/where/why fields', function() {
    var tmpDir = makeTempDir();
    var mock = createMockAudit();
    subscriber._setAudit(mock);
    subscriber._setPendingDir(tmpDir);

    writeEvent(tmpDir, 'fields.json', makeEvent('iteration_start', {
        iteration: '7',
        provider: 'codex',
    }, 'orchestrator'));

    subscriber._resetState();
    subscriber.scanPendingEvents();

    assert.strictEqual(mock.entries.length, 1);
    var entry = mock.entries[0];
    assert.strictEqual(entry.who, 'codex');
    assert.strictEqual(entry.what, 'iteration_start');
    assert.strictEqual(entry.where, 'iteration:7');
    assert.strictEqual(entry.why, 'RARV cycle iteration started');
    assert.ok(entry.metadata, 'metadata should be present');
    assert.strictEqual(entry.metadata.provider, 'codex');
    assert.strictEqual(entry.metadata.iteration, '7');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('policy events produce policy_violation and policy_approval entries', function() {
    var tmpDir = makeTempDir();
    var mock = createMockAudit();
    subscriber._setAudit(mock);
    subscriber._setPendingDir(tmpDir);

    writeEvent(tmpDir, 'policy1.json', makeEvent('policy_denied', {
        action: 'rm -rf /',
        provider: 'claude',
        iteration: '2',
    }));
    // v7.5.18: gemini removed; use aider as the test provider here.
    writeEvent(tmpDir, 'policy2.json', makeEvent('policy_approval_required', {
        action: 'deploy to prod',
        provider: 'aider',
        iteration: '5',
    }));

    subscriber._resetState();
    subscriber.scanPendingEvents();

    assert.strictEqual(mock.entries.length, 2);

    assert.strictEqual(mock.entries[0].what, 'policy_violation');
    assert.strictEqual(mock.entries[0].why, 'Policy engine blocked action');
    assert.strictEqual(mock.entries[0].who, 'claude');

    assert.strictEqual(mock.entries[1].what, 'policy_approval');
    assert.strictEqual(mock.entries[1].why, 'Policy requires approval');
    assert.strictEqual(mock.entries[1].who, 'aider');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('source field used as fallback for who when no provider in payload', function() {
    var tmpDir = makeTempDir();
    var mock = createMockAudit();
    subscriber._setAudit(mock);
    subscriber._setPendingDir(tmpDir);

    writeEvent(tmpDir, 'nosrc.json', makeEvent('session_start', { iteration: '1' }, 'my-source'));

    subscriber._resetState();
    subscriber.scanPendingEvents();

    assert.strictEqual(mock.entries.length, 1);
    assert.strictEqual(mock.entries[0].who, 'my-source', 'Should fall back to data.source');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});
