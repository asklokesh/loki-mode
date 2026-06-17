'use strict';
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var { execFileSync } = require('child_process');

var audit = require('../../src/audit');

var INDEX_JS = path.join(__dirname, '..', '..', 'src', 'audit', 'index.js');

function mkTmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loki-compliance-test-'));
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ }
}

// --- getReport() : object form with real chain integrity ---

test('getReport - honest empty report when chain has no entries', function () {
  var dir = mkTmpProject();
  try {
    audit.destroy();
    audit.init(dir);
    var report = audit.getReport('soc2');
    audit.destroy();
    assert.equal(report.reportType, 'SOC2_TYPE_II');
    assert.equal(report.totalAuditEntries, 0);
    // chainIntegrity must reflect the REAL verifyChain verdict, not null.
    assert.ok(report.chainIntegrity);
    assert.equal(report.chainIntegrity.valid, true);
    assert.equal(report.chainIntegrity.entries, 0);
    // No fabricated evidence.
    Object.keys(report.controls).forEach(function (id) {
      assert.equal(report.controls[id].evidenceCount, 0);
    });
  } finally {
    audit.destroy();
    rmrf(dir);
  }
});

test('getReport - reflects real recorded audit data', function () {
  var dir = mkTmpProject();
  try {
    audit.destroy();
    audit.init(dir);
    audit.record({ who: 'agent-1', what: 'file_write', where: 'a.js', why: 't' });
    audit.record({ who: 'agent-2', what: 'deploy', why: 'ship' });
    audit.flush();
    var report = audit.getReport('soc2');
    audit.destroy();
    assert.equal(report.totalAuditEntries, 2);
    assert.equal(report.chainIntegrity.valid, true);
    assert.equal(report.chainIntegrity.entries, 2);
    // file_write maps to CC6_3 -> real evidence.
    assert.ok(report.controls.CC6_3.evidenceCount > 0);
  } finally {
    audit.destroy();
    rmrf(dir);
  }
});

test('getReport - chainIntegrity catches tamper', function () {
  var dir = mkTmpProject();
  try {
    audit.destroy();
    audit.init(dir);
    audit.record({ who: 'agent-1', what: 'file_write', where: 'a.js', why: 't' });
    audit.flush();
    audit.destroy();
    // Tamper: rewrite the on-disk chain with a mutated entry.
    var chainFile = path.join(dir, '.loki', 'audit', 'audit.jsonl');
    var raw = fs.readFileSync(chainFile, 'utf8').trim();
    var entry = JSON.parse(raw.split('\n')[0]);
    entry.who = 'attacker';
    fs.writeFileSync(chainFile, JSON.stringify(entry) + '\n', 'utf8');
    audit.init(dir);
    var report = audit.getReport('soc2');
    audit.destroy();
    assert.equal(report.chainIntegrity.valid, false);
    assert.ok(report.chainIntegrity.error);
  } finally {
    audit.destroy();
    rmrf(dir);
  }
});

// --- CLI shim : node src/audit/index.js report <type> <projectDir> ---

function runCli(args) {
  try {
    var out = execFileSync(process.execPath, [INDEX_JS].concat(args), {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: out };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

test('CLI shim - usage error on bad invocation', function () {
  var r = runCli([]);
  assert.equal(r.code, 2);
  var parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.error);
});

test('CLI shim - rejects unknown report type', function () {
  var dir = mkTmpProject();
  try {
    var r = runCli(['report', 'bogus', dir]);
    assert.equal(r.code, 2);
    assert.ok(JSON.parse(r.stdout.trim()).error);
  } finally {
    rmrf(dir);
  }
});

test('CLI shim - honest empty report for a fresh project dir', function () {
  var dir = mkTmpProject();
  try {
    var r = runCli(['report', 'soc2', dir]);
    assert.equal(r.code, 0);
    var report = JSON.parse(r.stdout.trim());
    assert.equal(report.reportType, 'SOC2_TYPE_II');
    assert.equal(report.totalAuditEntries, 0);
    assert.equal(report.chainIntegrity.valid, true);
  } finally {
    rmrf(dir);
  }
});

test('CLI shim - returns real data written to the project chain', function () {
  var dir = mkTmpProject();
  try {
    audit.destroy();
    audit.init(dir);
    audit.record({ who: 'agent-1', what: 'file_write', where: 'a.js', why: 't' });
    audit.record({ who: 'agent-1', what: 'test_run', why: 'verify' });
    audit.flush();
    audit.destroy();
    var r = runCli(['report', 'iso27001', dir]);
    assert.equal(r.code, 0);
    var report = JSON.parse(r.stdout.trim());
    assert.equal(report.reportType, 'ISO27001');
    assert.equal(report.totalAuditEntries, 2);
    assert.equal(report.chainIntegrity.valid, true);
    assert.ok(report.controls['A.14.2'].evidenceCount > 0);
  } finally {
    audit.destroy();
    rmrf(dir);
  }
});
