'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const subscriber = require('../../src/integrations/sync-subscriber');
const {
  RARV_STATUS_MAP,
  resolveStatus,
  buildDetails,
  processEventFile,
  dispatchToIntegrations,
  scanPendingEvents,
  _getIntegrations,
  _setIntegrations,
  _getLastProcessedFile,
  _resetState,
  _setPendingDir,
} = subscriber;

// --- Helpers ---

/**
 * Create a temporary directory for test event files.
 * Returns the path. Caller is responsible for cleanup.
 */
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sync-sub-test-'));
}

/**
 * Write a JSON event file into the given directory.
 */
function writeEvent(dir, filename, data) {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data), 'utf8');
}

/**
 * Build a minimal valid event object.
 */
function makeEvent(type, payload) {
  return {
    id: 'test-' + Date.now(),
    type: type,
    source: 'test',
    timestamp: '2026-02-21T00:00:00.000Z',
    payload: payload || {},
    version: '1.0',
  };
}

// --- Tests ---

describe('sync-subscriber', () => {
  describe('initIntegrations (Jira)', () => {
    const keys = ['LOKI_JIRA_URL', 'LOKI_JIRA_EMAIL', 'LOKI_JIRA_TOKEN', 'LOKI_LINEAR_TOKEN', 'LOKI_GITHUB_SYNC'];
    let saved, prevLog, prevErr, errs, logs;
    beforeEach(() => {
      saved = {};
      keys.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
      subscriber._setIntegrations([]);
      prevLog = console.log; prevErr = console.error; errs = []; logs = [];
      console.log = (m) => logs.push(String(m));
      console.error = (m) => errs.push(String(m));
    });
    afterEach(() => {
      console.log = prevLog; console.error = prevErr;
      keys.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
      subscriber._setIntegrations([]);
    });

    it('constructs a Jira client when url, email and token are set', () => {
      process.env.LOKI_JIRA_URL = 'https://example.atlassian.net';
      process.env.LOKI_JIRA_EMAIL = 'u@example.com';
      process.env.LOKI_JIRA_TOKEN = 'tok';
      subscriber.initIntegrations();
      const list = subscriber._getIntegrations();
      assert.equal(list.length, 1);
      assert.equal(list[0].name, 'jira');
      assert.deepEqual(errs, []);
    });

    it('logs one line naming the missing variable', () => {
      process.env.LOKI_JIRA_URL = 'https://example.atlassian.net';
      process.env.LOKI_JIRA_TOKEN = 'tok';
      const realExit = process.exit;
      process.exit = () => {};
      try { subscriber.initIntegrations(); } finally { process.exit = realExit; }
      assert.equal(subscriber._getIntegrations().length, 0);
      assert.equal(errs.length, 1);
      assert.match(errs[0], /missing: LOKI_JIRA_EMAIL$/);
    });
  });

  describe('RARV_STATUS_MAP', () => {
    it('maps iteration_start to building', () => {
      assert.equal(RARV_STATUS_MAP['iteration_start'], 'building');
    });

    it('maps session_start to planning', () => {
      assert.equal(RARV_STATUS_MAP['session_start'], 'planning');
    });

    it('does not contain unknown event types', () => {
      assert.equal(RARV_STATUS_MAP['unknown_event'], undefined);
    });

    it('iteration_complete mapper is a function', () => {
      assert.equal(typeof RARV_STATUS_MAP['iteration_complete'], 'function');
    });

    it('session_end mapper is a function', () => {
      assert.equal(typeof RARV_STATUS_MAP['session_end'], 'function');
    });

    it('phase_change mapper is a function', () => {
      assert.equal(typeof RARV_STATUS_MAP['phase_change'], 'function');
    });
  });

  describe('resolveStatus', () => {
    it('returns building for iteration_start', () => {
      assert.equal(resolveStatus('iteration_start', {}), 'building');
    });

    it('returns planning for session_start', () => {
      assert.equal(resolveStatus('session_start', {}), 'planning');
    });

    it('returns completed for successful iteration_complete', () => {
      assert.equal(resolveStatus('iteration_complete', { status: 'completed' }), 'completed');
    });

    it('returns failed for non-completed iteration_complete', () => {
      assert.equal(resolveStatus('iteration_complete', { status: 'error' }), 'failed');
    });

    it('returns completed for session_end with result 0', () => {
      assert.equal(resolveStatus('session_end', { result: '0' }), 'completed');
    });

    it('returns failed for session_end with non-zero result', () => {
      assert.equal(resolveStatus('session_end', { result: '1' }), 'failed');
    });

    it('maps phase_change REASON to planning', () => {
      assert.equal(resolveStatus('phase_change', { phase: 'REASON' }), 'planning');
    });

    it('maps phase_change ACT to building', () => {
      assert.equal(resolveStatus('phase_change', { phase: 'ACT' }), 'building');
    });

    it('maps phase_change REFLECT to reviewing', () => {
      assert.equal(resolveStatus('phase_change', { phase: 'REFLECT' }), 'reviewing');
    });

    it('maps phase_change VERIFY to testing', () => {
      assert.equal(resolveStatus('phase_change', { phase: 'VERIFY' }), 'testing');
    });

    it('maps unknown phase to building (default)', () => {
      assert.equal(resolveStatus('phase_change', { phase: 'UNKNOWN' }), 'building');
    });

    it('returns null for unrecognized event type', () => {
      assert.equal(resolveStatus('random_event', {}), null);
    });

    it('returns null for empty string event type', () => {
      assert.equal(resolveStatus('', {}), null);
    });
  });

  describe('buildDetails', () => {
    it('extracts iteration, provider, phase, and timestamp', () => {
      var data = { timestamp: '2026-01-01T00:00:00Z' };
      var payload = { iteration: 3, provider: 'claude', phase: 'ACT' };
      var details = buildDetails(data, payload);

      assert.equal(details.iteration, 3);
      assert.equal(details.provider, 'claude');
      assert.equal(details.phase, 'ACT');
      assert.equal(details.timestamp, '2026-01-01T00:00:00Z');
    });

    it('falls back to action when phase is absent', () => {
      var data = { timestamp: '2026-01-01T00:00:00Z' };
      var payload = { action: 'start' };
      var details = buildDetails(data, payload);

      assert.equal(details.phase, 'start');
    });

    it('handles missing fields gracefully', () => {
      var details = buildDetails({}, {});
      assert.equal(details.iteration, undefined);
      assert.equal(details.provider, undefined);
      assert.equal(details.phase, undefined);
      assert.equal(details.timestamp, undefined);
    });
  });

  describe('processEventFile', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = makeTempDir();
      _setIntegrations([]);
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('processes a valid iteration_start event without crashing', () => {
      var eventFile = path.join(tmpDir, 'evt-001.json');
      writeEvent(tmpDir, 'evt-001.json', makeEvent('iteration_start', { iteration: 1 }));

      // Should not throw even with no integrations
      assert.doesNotThrow(() => processEventFile(eventFile));
    });

    it('ignores unknown event types silently', () => {
      var eventFile = path.join(tmpDir, 'evt-002.json');
      writeEvent(tmpDir, 'evt-002.json', makeEvent('unknown_type', {}));

      assert.doesNotThrow(() => processEventFile(eventFile));
    });

    it('handles missing file without crashing', () => {
      assert.doesNotThrow(() => processEventFile(path.join(tmpDir, 'nonexistent.json')));
    });

    it('handles malformed JSON without crashing', () => {
      var filepath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(filepath, '{not valid json', 'utf8');
      assert.doesNotThrow(() => processEventFile(filepath));
    });

    it('handles event with missing payload field', () => {
      var filepath = path.join(tmpDir, 'no-payload.json');
      fs.writeFileSync(filepath, JSON.stringify({ type: 'iteration_start' }), 'utf8');
      assert.doesNotThrow(() => processEventFile(filepath));
    });

    it('dispatches iteration_start to configured jira integration', function() {
      var calls = [];
      _setIntegrations([{
        name: 'jira',
        epicKey: 'PROJ-1',
        syncManager: {
          syncToJira: function(key, state) {
            calls.push({ key: key, state: state });
            return Promise.resolve();
          }
        }
      }]);

      var eventFile = path.join(tmpDir, 'test-dispatch.json');
      fs.writeFileSync(eventFile, JSON.stringify({
        id: 'abc',
        type: 'iteration_start',
        source: 'cli',
        timestamp: '2026-02-21T10:00:00.000Z',
        payload: { action: 'start', iteration: '1', provider: 'claude' },
        version: '1.0'
      }));

      processEventFile(eventFile);

      // Give async dispatch a tick
      return new Promise(function(resolve) {
        setTimeout(function() {
          assert.equal(calls.length, 1);
          assert.equal(calls[0].key, 'PROJ-1');
          assert.equal(calls[0].state.phase, 'building');
          resolve();
        }, 50);
      });
    });

    it('dispatches iteration_complete success as completed', function() {
      var calls = [];
      _setIntegrations([{
        name: 'jira',
        epicKey: 'PROJ-1',
        syncManager: {
          syncToJira: function(key, state) {
            calls.push({ key: key, state: state });
            return Promise.resolve();
          }
        }
      }]);

      var eventFile = path.join(tmpDir, 'test-complete.json');
      fs.writeFileSync(eventFile, JSON.stringify({
        id: 'def',
        type: 'iteration_complete',
        source: 'cli',
        timestamp: '2026-02-21T10:01:00.000Z',
        payload: { action: 'complete', iteration: '1', status: 'completed', provider: 'claude' },
        version: '1.0'
      }));

      processEventFile(eventFile);

      return new Promise(function(resolve) {
        setTimeout(function() {
          assert.equal(calls.length, 1);
          assert.equal(calls[0].state.phase, 'completed');
          resolve();
        }, 50);
      });
    });
  });

  describe('dispatchToIntegrations', () => {
    let originalIntegrations;

    beforeEach(() => {
      originalIntegrations = _getIntegrations().slice();
    });

    afterEach(() => {
      _setIntegrations(originalIntegrations);
    });

    it('calls jira syncToJira with correct status and details', async () => {
      var syncCalls = [];
      var mockSyncManager = {
        syncToJira: function (epicKey, rarvState) {
          syncCalls.push({ epicKey: epicKey, rarvState: rarvState });
          return Promise.resolve();
        },
      };

      _setIntegrations([{
        name: 'jira',
        epicKey: 'PROJ-100',
        syncManager: mockSyncManager,
      }]);

      var details = { iteration: 1, provider: 'claude', phase: 'ACT', timestamp: 'T' };
      dispatchToIntegrations('building', details);

      // Allow promise to resolve
      await new Promise(function (r) { setTimeout(r, 10); });

      assert.equal(syncCalls.length, 1);
      assert.equal(syncCalls[0].epicKey, 'PROJ-100');
      assert.equal(syncCalls[0].rarvState.phase, 'building');
      assert.ok(syncCalls[0].rarvState.details.includes('"iteration":1'));
    });

    it('skips jira dispatch when epicKey is not set', () => {
      var syncCalls = [];
      var mockSyncManager = {
        syncToJira: function () {
          syncCalls.push(true);
          return Promise.resolve();
        },
      };

      _setIntegrations([{
        name: 'jira',
        epicKey: null,
        syncManager: mockSyncManager,
      }]);

      dispatchToIntegrations('building', {});
      assert.equal(syncCalls.length, 0);
    });

    it('calls linear updateProjectStatus when available', async () => {
      var linearCalls = [];
      var mockClient = {
        updateProjectStatus: function (projectId, status) {
          linearCalls.push({ projectId: projectId, status: status });
          return Promise.resolve();
        },
      };

      _setIntegrations([{
        name: 'linear',
        projectId: 'proj-abc',
        client: mockClient,
      }]);

      dispatchToIntegrations('testing', {});

      await new Promise(function (r) { setTimeout(r, 10); });

      assert.equal(linearCalls.length, 1);
      assert.equal(linearCalls[0].projectId, 'proj-abc');
      assert.equal(linearCalls[0].status, 'testing');
    });

    it('skips linear when projectId is not set', () => {
      var linearCalls = [];
      var mockClient = {
        updateProjectStatus: function () {
          linearCalls.push(true);
          return Promise.resolve();
        },
      };

      _setIntegrations([{
        name: 'linear',
        projectId: null,
        client: mockClient,
      }]);

      dispatchToIntegrations('testing', {});
      assert.equal(linearCalls.length, 0);
    });

    it('skips linear when updateProjectStatus is not defined', () => {
      _setIntegrations([{
        name: 'linear',
        projectId: 'proj-abc',
        client: {},
      }]);

      // Should not throw
      assert.doesNotThrow(() => dispatchToIntegrations('testing', {}));
    });

    it('dispatches to multiple integrations simultaneously', async () => {
      var jiraCalls = [];
      var linearCalls = [];

      _setIntegrations([
        {
          name: 'jira',
          epicKey: 'PROJ-1',
          syncManager: {
            syncToJira: function (key, state) {
              jiraCalls.push({ key: key, state: state });
              return Promise.resolve();
            },
          },
        },
        {
          name: 'linear',
          projectId: 'proj-1',
          client: {
            updateProjectStatus: function (id, status) {
              linearCalls.push({ id: id, status: status });
              return Promise.resolve();
            },
          },
        },
      ]);

      dispatchToIntegrations('completed', {});

      await new Promise(function (r) { setTimeout(r, 10); });

      assert.equal(jiraCalls.length, 1);
      assert.equal(linearCalls.length, 1);
    });

    it('does not crash when jira syncToJira rejects', async () => {
      var mockSyncManager = {
        syncToJira: function () {
          return Promise.reject(new Error('network error'));
        },
      };

      _setIntegrations([{
        name: 'jira',
        epicKey: 'PROJ-1',
        syncManager: mockSyncManager,
      }]);

      // Should not throw
      assert.doesNotThrow(() => dispatchToIntegrations('building', {}));

      // Let the rejection handler run
      await new Promise(function (r) { setTimeout(r, 20); });
    });

    it('handles github integration type gracefully (no-op)', () => {
      _setIntegrations([{
        name: 'github',
        reporter: {},
      }]);

      assert.doesNotThrow(() => dispatchToIntegrations('completed', {}));
    });
  });

  describe('scanPendingEvents', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = makeTempDir();
      _setPendingDir(tmpDir);
      _resetState();
      _setIntegrations([]);
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('processes new event files in the pending directory', () => {
      writeEvent(tmpDir, 'evt-001.json', makeEvent('iteration_start', { iteration: 1 }));
      writeEvent(tmpDir, 'evt-002.json', makeEvent('session_start', {}));

      scanPendingEvents();

      // Watermark should be at last file processed
      assert.equal(_getLastProcessedFile(), 'evt-002.json');
    });

    it('does not re-process already seen files', () => {
      writeEvent(tmpDir, 'evt-001.json', makeEvent('iteration_start', {}));

      scanPendingEvents();
      assert.equal(_getLastProcessedFile(), 'evt-001.json');

      // Scan again - watermark unchanged means no re-processing
      scanPendingEvents();
      assert.equal(_getLastProcessedFile(), 'evt-001.json');
    });

    it('ignores non-JSON files', () => {
      fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'hello', 'utf8');
      writeEvent(tmpDir, 'evt-001.json', makeEvent('session_start', {}));

      scanPendingEvents();

      assert.equal(_getLastProcessedFile(), 'evt-001.json');
    });

    it('handles nonexistent pending directory gracefully', () => {
      _setPendingDir(path.join(tmpDir, 'does-not-exist'));
      assert.doesNotThrow(() => scanPendingEvents());
    });

    it('processes files in sorted order', () => {
      // Write files out of order
      writeEvent(tmpDir, 'evt-003.json', makeEvent('session_start', {}));
      writeEvent(tmpDir, 'evt-001.json', makeEvent('iteration_start', {}));
      writeEvent(tmpDir, 'evt-002.json', makeEvent('phase_change', { phase: 'ACT' }));

      scanPendingEvents();

      // Watermark should be at the last sorted file
      assert.equal(_getLastProcessedFile(), 'evt-003.json');
    });
  });

  describe('watermark deduplication', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = makeTempDir();
      _setPendingDir(tmpDir);
      _resetState();
      _setIntegrations([]);
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('advances watermark across multiple scans', () => {
      writeEvent(tmpDir, 'batch1-001.json', makeEvent('session_start', {}));
      scanPendingEvents();
      assert.equal(_getLastProcessedFile(), 'batch1-001.json');

      writeEvent(tmpDir, 'batch2-001.json', makeEvent('iteration_start', {}));
      scanPendingEvents();
      assert.equal(_getLastProcessedFile(), 'batch2-001.json');
    });
  });

  describe('end-to-end event flow', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = makeTempDir();
      _setPendingDir(tmpDir);
      _resetState();
    });

    afterEach(() => {
      _setIntegrations([]);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('full flow: write event file, scan, dispatch to mock jira', async () => {
      var syncCalls = [];
      _setIntegrations([{
        name: 'jira',
        epicKey: 'PROJ-42',
        syncManager: {
          syncToJira: function (key, state) {
            syncCalls.push({ key: key, state: state });
            return Promise.resolve();
          },
        },
      }]);

      var event = makeEvent('phase_change', { phase: 'VERIFY', iteration: 5 });
      writeEvent(tmpDir, 'evt-flow-001.json', event);

      scanPendingEvents();

      await new Promise(function (r) { setTimeout(r, 20); });

      assert.equal(syncCalls.length, 1);
      assert.equal(syncCalls[0].key, 'PROJ-42');
      assert.equal(syncCalls[0].state.phase, 'testing');
    });

    it('full flow: multiple events dispatch to multiple integrations', async () => {
      var jiraCalls = [];
      var linearCalls = [];

      _setIntegrations([
        {
          name: 'jira',
          epicKey: 'PROJ-1',
          syncManager: {
            syncToJira: function (key, state) {
              jiraCalls.push({ key: key, phase: state.phase });
              return Promise.resolve();
            },
          },
        },
        {
          name: 'linear',
          projectId: 'proj-lin-1',
          client: {
            updateProjectStatus: function (id, status) {
              linearCalls.push({ id: id, status: status });
              return Promise.resolve();
            },
          },
        },
      ]);

      writeEvent(tmpDir, 'evt-001.json', makeEvent('session_start', {}));
      writeEvent(tmpDir, 'evt-002.json', makeEvent('phase_change', { phase: 'ACT' }));
      writeEvent(tmpDir, 'evt-003.json', makeEvent('iteration_complete', { status: 'completed' }));

      scanPendingEvents();

      await new Promise(function (r) { setTimeout(r, 30); });

      // 3 events x jira
      assert.equal(jiraCalls.length, 3);
      assert.equal(jiraCalls[0].phase, 'planning');
      assert.equal(jiraCalls[1].phase, 'building');
      assert.equal(jiraCalls[2].phase, 'completed');

      // 3 events x linear
      assert.equal(linearCalls.length, 3);
      assert.equal(linearCalls[0].status, 'planning');
      assert.equal(linearCalls[1].status, 'building');
      assert.equal(linearCalls[2].status, 'completed');
    });
  });
});
