'use strict';
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var scheduler = require('../../src/audit/compliance-scheduler');
var audit = require('../../src/audit');

function mkTmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loki-compliance-sched-test-'));
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ }
}

function recordSome(dir) {
  audit.destroy();
  audit.init(dir);
  audit.record({ who: 'agent-1', what: 'file_write', where: 'a.js', why: 't' });
  audit.record({ who: 'agent-2', what: 'deploy', why: 'ship' });
  audit.flush();
  audit.destroy();
}

function listSnapshots(dir) {
  var sdir = scheduler.snapshotDir(dir);
  if (!fs.existsSync(sdir)) return [];
  return fs.readdirSync(sdir).filter(function (f) {
    return f.indexOf('compliance-') === 0 && f.slice(-5) === '.json';
  });
}

// --- interval disabled -> no-op ---

test('maybeGenerateSnapshot - disabled (interval 0) is a no-op', function () {
  var dir = mkTmpProject();
  try {
    recordSome(dir);
    var res = scheduler.maybeGenerateSnapshot({ projectDir: dir, intervalHours: 0, now: 1000 });
    assert.equal(res.generated, false);
    assert.equal(res.reason, 'disabled');
    assert.equal(listSnapshots(dir).length, 0, 'no snapshot file should be written when disabled');
  } finally {
    rmrf(dir);
  }
});

test('maybeGenerateSnapshot - unset env interval is a no-op (default disabled)', function () {
  var dir = mkTmpProject();
  var prev = process.env[scheduler.ENV_INTERVAL];
  try {
    delete process.env[scheduler.ENV_INTERVAL];
    recordSome(dir);
    var res = scheduler.maybeGenerateSnapshot({ projectDir: dir, now: 1000 });
    assert.equal(res.generated, false);
    assert.equal(res.reason, 'disabled');
    assert.equal(listSnapshots(dir).length, 0);
  } finally {
    if (prev === undefined) delete process.env[scheduler.ENV_INTERVAL];
    else process.env[scheduler.ENV_INTERVAL] = prev;
    rmrf(dir);
  }
});

// --- interval elapsed -> snapshot written with REAL data ---

test('maybeGenerateSnapshot - first run with interval > 0 generates real-data snapshot', function () {
  var dir = mkTmpProject();
  try {
    recordSome(dir);
    var res = scheduler.maybeGenerateSnapshot({ projectDir: dir, intervalHours: 24, now: 1000 });
    assert.equal(res.generated, true);
    assert.equal(res.reason, undefined);
    assert.ok(res.path, 'a path is returned');
    assert.ok(fs.existsSync(res.path), 'snapshot file exists on disk');
    assert.equal(listSnapshots(dir).length, 1);

    // Snapshot reflects REAL recorded data, not a fabricated pass.
    var snap = JSON.parse(fs.readFileSync(res.path, 'utf8'));
    assert.equal(snap.totalAuditEntries, 2);
    assert.equal(snap.chainIntegrity.valid, true);
    assert.equal(snap.chainIntegrity.entries, 2);
    assert.equal(snap.reports.soc2.reportType, 'SOC2_TYPE_II');
    assert.equal(snap.reports.iso27001.reportType, 'ISO27001');
    assert.equal(snap.reports.gdpr.reportType, 'GDPR_DATA_PROCESSING_RECORD');
    // file_write -> CC6_3 real evidence; deploy -> CC8_1 real evidence.
    assert.ok(snap.reports.soc2.controls.CC6_3.evidenceCount > 0);
    assert.equal(snap.reports.soc2.chainIntegrity.valid, true);
  } finally {
    rmrf(dir);
  }
});

test('maybeGenerateSnapshot - generates again once the interval has elapsed', function () {
  var dir = mkTmpProject();
  try {
    recordSome(dir);
    var T0 = 1000000;
    var first = scheduler.maybeGenerateSnapshot({ projectDir: dir, intervalHours: 1, now: T0 });
    assert.equal(first.generated, true);

    // T0 + just over 1 hour -> elapsed -> generates a second snapshot.
    var later = T0 + (3600 * 1000) + 1;
    var second = scheduler.maybeGenerateSnapshot({ projectDir: dir, intervalHours: 1, now: later });
    assert.equal(second.generated, true);
    assert.notEqual(second.path, first.path, 'second snapshot is a distinct file');
    assert.equal(listSnapshots(dir).length, 2);
  } finally {
    rmrf(dir);
  }
});

// --- interval not elapsed -> no-op ---

test('maybeGenerateSnapshot - no-op when interval has not elapsed', function () {
  var dir = mkTmpProject();
  try {
    recordSome(dir);
    var T0 = 1000000;
    var first = scheduler.maybeGenerateSnapshot({ projectDir: dir, intervalHours: 24, now: T0 });
    assert.equal(first.generated, true);

    // Only 1 hour later, interval is 24h -> not elapsed -> no-op.
    var soon = T0 + (3600 * 1000);
    var second = scheduler.maybeGenerateSnapshot({ projectDir: dir, intervalHours: 24, now: soon });
    assert.equal(second.generated, false);
    assert.equal(second.reason, 'not-elapsed');
    assert.ok(typeof second.nextEligibleAtMs === 'number');
    assert.equal(listSnapshots(dir).length, 1, 'still only one snapshot');
  } finally {
    rmrf(dir);
  }
});

// --- empty chain -> honest-empty snapshot ---

test('maybeGenerateSnapshot - empty chain yields an honest-empty snapshot', function () {
  var dir = mkTmpProject();
  try {
    // No audit data recorded at all.
    var res = scheduler.maybeGenerateSnapshot({ projectDir: dir, intervalHours: 24, now: 1000 });
    assert.equal(res.generated, true);
    var snap = JSON.parse(fs.readFileSync(res.path, 'utf8'));
    assert.equal(snap.totalAuditEntries, 0, 'honest zero, never fabricated');
    // An empty chain is honestly valid (nothing to tamper with), entries 0.
    assert.equal(snap.chainIntegrity.valid, true);
    assert.equal(snap.chainIntegrity.entries, 0);
    // No fabricated evidence in any control.
    Object.keys(snap.reports.soc2.controls).forEach(function (id) {
      assert.equal(snap.reports.soc2.controls[id].evidenceCount, 0);
    });
  } finally {
    rmrf(dir);
  }
});

// --- parseIntervalHours unit coverage (disabled-by-default semantics) ---

test('parseIntervalHours - unset / invalid / non-positive map to 0 (disabled)', function () {
  assert.equal(scheduler.parseIntervalHours(undefined), 0);
  assert.equal(scheduler.parseIntervalHours(null), 0);
  assert.equal(scheduler.parseIntervalHours(''), 0);
  assert.equal(scheduler.parseIntervalHours('abc'), 0);
  assert.equal(scheduler.parseIntervalHours('-5'), 0);
  assert.equal(scheduler.parseIntervalHours('0'), 0);
  assert.equal(scheduler.parseIntervalHours('24'), 24);
  assert.equal(scheduler.parseIntervalHours(6), 6);
  assert.equal(scheduler.parseIntervalHours(0.5), 0.5);
});
