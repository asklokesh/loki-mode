'use strict';

/**
 * P3-9: unify the two audit chains.
 *
 * Proves the cross-link layer (src/audit/crosslink.js) treats the agent
 * (JS, src/audit/log.js) chain and the dashboard (Python,
 * dashboard/audit.py) chain as ONE logical tamper-evident trail:
 *   - verifies clean when both sub-chains are intact;
 *   - detects tampering in the AGENT (JS) source;
 *   - detects tampering in the DASHBOARD (Python) source (post cross-link);
 *   - append-only witness works and detects a rewritten witness file.
 */

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');
var { execFileSync } = require('child_process');

var { AuditLog } = require('../../src/audit/log');
var crosslink = require('../../src/audit/crosslink');

var REPO_ROOT = path.join(__dirname, '..', '..');
var AUDIT_PY = path.join(REPO_ROOT, 'dashboard', 'audit.py');
var PYTHON = process.env.LOKI_PYTHON || 'python3';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loki-xlink-test-'));
}
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

/**
 * Seed the Python dashboard chain by running dashboard/audit.py's real
 * log_event() writer with HOME pointed at a temp dir, so it writes into
 * <fakeHome>/.loki/dashboard/audit/audit-*.jsonl with correct
 * _integrity_hash chaining. Returns the audit dir.
 */
function seedDashboardChain(fakeHome, events) {
  var py = [
    'import sys, os',
    'sys.path.insert(0, ' + JSON.stringify(path.join(REPO_ROOT, 'dashboard')) + ')',
    'import audit',
    'for a, rt in ' + JSON.stringify(events) + ':',
    '    audit.log_event(a, rt)',
    'print("seeded")',
  ].join('\n');
  var out = execFileSync(PYTHON, ['-c', py], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { HOME: fakeHome }),
  });
  assert.match(out, /seeded/);
  return path.join(fakeHome, '.loki', 'dashboard', 'audit');
}

function commonOpts(agentDir, dashDir) {
  return {
    logDir: agentDir,
    dashboardAuditDir: dashDir,
    auditPyPath: AUDIT_PY,
    pythonBin: PYTHON,
    witnessFile: path.join(agentDir, 'witness.jsonl'),
  };
}

test('crosslink - unified trail verifies clean across both sources', function (t) {
  var dir = makeTmpDir();
  try {
    var agentDir = path.join(dir, 'agent');
    var fakeHome = path.join(dir, 'home');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(fakeHome, { recursive: true });

    // Seed both chains.
    var dashDir = seedDashboardChain(fakeHome, [
      ['login', 'session'], ['create', 'project'], ['deploy', 'release'],
    ]);
    var log = new AuditLog({ logDir: agentDir });
    log.record({ who: 'agent-1', what: 'file_write', where: 'a.js' });
    log.record({ who: 'agent-1', what: 'command_execute' });
    log.flush();
    log.destroy();

    var opts = commonOpts(agentDir, dashDir);

    // Cross-link the dashboard chain into the agent chain.
    var linked = crosslink.crossLink(opts);
    assert.equal(linked.dashboard.available, true);
    assert.equal(linked.dashboard.valid, true);
    assert.ok(linked.anchor.hash, 'anchor recorded with a hash');
    assert.ok(linked.unifiedRoot);

    // Unified verify must pass.
    var result = crosslink.verifyUnified(opts);
    assert.equal(result.valid, true, JSON.stringify(result, null, 2));
    assert.equal(result.agent.valid, true);
    assert.equal(result.dashboard.valid, true);
    assert.equal(result.anchors.valid, true);
    assert.equal(result.anchors.count, 1);
  } finally { cleanup(dir); }
});

test('crosslink - detects tampering in the AGENT (JS) source', function (t) {
  var dir = makeTmpDir();
  try {
    var agentDir = path.join(dir, 'agent');
    var fakeHome = path.join(dir, 'home');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(fakeHome, { recursive: true });

    var dashDir = seedDashboardChain(fakeHome, [['login', 'session']]);
    var log = new AuditLog({ logDir: agentDir });
    log.record({ who: 'agent-1', what: 'file_write' });
    log.record({ who: 'agent-1', what: 'deploy' });
    log.flush();
    log.destroy();

    var opts = commonOpts(agentDir, dashDir);
    crosslink.crossLink(opts);
    assert.equal(crosslink.verifyUnified(opts).valid, true, 'clean before tamper');

    // Tamper with the agent log file (mutate first entry's `who`).
    var agentFile = path.join(agentDir, 'audit.jsonl');
    var lines = fs.readFileSync(agentFile, 'utf8').trim().split('\n');
    var e0 = JSON.parse(lines[0]);
    e0.who = 'attacker';
    lines[0] = JSON.stringify(e0);
    fs.writeFileSync(agentFile, lines.join('\n') + '\n');

    var result = crosslink.verifyUnified(opts);
    assert.equal(result.valid, false, 'unified verify must FAIL on agent tamper');
    assert.equal(result.agent.valid, false);
    assert.ok(result.agent.error && result.agent.error.length > 0);
  } finally { cleanup(dir); }
});

test('crosslink - detects tampering in the DASHBOARD (Python) source', function (t) {
  var dir = makeTmpDir();
  try {
    var agentDir = path.join(dir, 'agent');
    var fakeHome = path.join(dir, 'home');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(fakeHome, { recursive: true });

    var dashDir = seedDashboardChain(fakeHome, [
      ['login', 'session'], ['delete', 'token'], ['deploy', 'release'],
    ]);
    var log = new AuditLog({ logDir: agentDir });
    log.record({ who: 'agent-1', what: 'file_write' });
    log.flush();
    log.destroy();

    var opts = commonOpts(agentDir, dashDir);
    crosslink.crossLink(opts);
    assert.equal(crosslink.verifyUnified(opts).valid, true, 'clean before tamper');

    // Tamper with the dashboard log file (mutate an action mid-chain).
    var dashFiles = fs.readdirSync(dashDir).filter(function (f) {
      return /^audit-.*\.jsonl$/.test(f);
    });
    assert.ok(dashFiles.length > 0, 'dashboard log file exists');
    var dashFile = path.join(dashDir, dashFiles[0]);
    var dlines = fs.readFileSync(dashFile, 'utf8').trim().split('\n');
    var d0 = JSON.parse(dlines[0]);
    d0.action = 'tampered_action';
    dlines[0] = JSON.stringify(d0);
    fs.writeFileSync(dashFile, dlines.join('\n') + '\n');

    var result = crosslink.verifyUnified(opts);
    assert.equal(result.valid, false, 'unified verify must FAIL on dashboard tamper');
    assert.equal(result.dashboard.available, true);
    assert.equal(result.dashboard.valid, false);
  } finally { cleanup(dir); }
});

test('crosslink - legitimate dashboard GROWTH after cross-link still verifies', function (t) {
  var dir = makeTmpDir();
  try {
    var agentDir = path.join(dir, 'agent');
    var fakeHome = path.join(dir, 'home');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(fakeHome, { recursive: true });

    var dashDir = seedDashboardChain(fakeHome, [
      ['login', 'session'], ['create', 'project'], ['deploy', 'release'],
    ]);
    var log = new AuditLog({ logDir: agentDir });
    log.record({ who: 'agent-1', what: 'file_write' });
    log.flush();
    log.destroy();

    var opts = commonOpts(agentDir, dashDir);
    crosslink.crossLink(opts);
    assert.equal(crosslink.verifyUnified(opts).valid, true, 'clean right after link');

    // The dashboard is a LIVE append-only log: append more events after
    // the cross-link (the normal case). The unified trail must remain
    // valid -- growth is not tampering.
    seedDashboardChain(fakeHome, [['update', 'project'], ['logout', 'session']]);

    var result = crosslink.verifyUnified(opts);
    assert.equal(result.valid, true,
      'dashboard growth after cross-link must still verify: ' +
      JSON.stringify(result, null, 2));
    assert.equal(result.dashboard.valid, true);
    assert.equal(result.anchors.valid, true);
    // Live tip moved forward (5 entries now vs 3 pinned).
    assert.equal(result.dashboard.entries, 5);
  } finally { cleanup(dir); }
});

test('crosslink - latest anchor catches dashboard history truncation', function (t) {
  var dir = makeTmpDir();
  try {
    var agentDir = path.join(dir, 'agent');
    var fakeHome = path.join(dir, 'home');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(fakeHome, { recursive: true });

    var dashDir = seedDashboardChain(fakeHome, [
      ['login', 'session'], ['create', 'project'], ['deploy', 'release'],
    ]);
    var log = new AuditLog({ logDir: agentDir });
    log.record({ who: 'agent-1', what: 'file_write' });
    log.flush();
    log.destroy();

    var opts = commonOpts(agentDir, dashDir);
    crosslink.crossLink(opts);
    assert.equal(crosslink.verifyUnified(opts).valid, true);

    // Delete the LAST dashboard entry (truncation). The chain up to the
    // remaining tip still self-verifies, but the recorded anchor tip no
    // longer matches the live tip -> anchor reconciliation must fail.
    var dashFiles = fs.readdirSync(dashDir).filter(function (f) {
      return /^audit-.*\.jsonl$/.test(f);
    });
    var dashFile = path.join(dashDir, dashFiles[0]);
    var dlines = fs.readFileSync(dashFile, 'utf8').trim().split('\n');
    dlines.pop();
    fs.writeFileSync(dashFile, dlines.join('\n') + '\n');

    var result = crosslink.verifyUnified(opts);
    assert.equal(result.valid, false, 'truncation must fail unified verify');
    assert.equal(result.dashboard.valid, true, 'remaining dashboard chain self-verifies');
    assert.equal(result.anchors.valid, false, 'anchor reconciliation catches truncation');
  } finally { cleanup(dir); }
});

test('crosslink - append-only witness writes and detects rewrite', function (t) {
  var dir = makeTmpDir();
  try {
    var agentDir = path.join(dir, 'agent');
    var fakeHome = path.join(dir, 'home');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(fakeHome, { recursive: true });

    var dashDir = seedDashboardChain(fakeHome, [['login', 'session']]);
    var log = new AuditLog({ logDir: agentDir });
    log.record({ who: 'agent-1', what: 'file_write' });
    log.flush();
    log.destroy();

    var opts = commonOpts(agentDir, dashDir);
    var w1 = crosslink.writeWitness(opts);
    assert.ok(fs.existsSync(w1.witnessFile));

    // Grow both chains, write a second witness (append, not rewrite).
    var log2 = new AuditLog({ logDir: agentDir });
    log2.record({ who: 'agent-1', what: 'deploy' });
    log2.record({ who: 'agent-1', what: 'command_execute' });
    log2.flush();
    log2.destroy();
    crosslink.writeWitness(opts);

    var ok = crosslink.verifyWitnessFile(opts.witnessFile);
    assert.equal(ok.present, true);
    assert.equal(ok.valid, true);
    assert.equal(ok.witnesses, 2);

    // Rewrite the witness file so the second line shows FEWER entries
    // than the first (append-only violation -> must be detected).
    var wlines = fs.readFileSync(opts.witnessFile, 'utf8').trim().split('\n');
    var second = JSON.parse(wlines[1]);
    second.agentEntries = 0;
    second.dashboardEntries = 0;
    wlines[1] = JSON.stringify(second);
    fs.writeFileSync(opts.witnessFile, wlines.join('\n') + '\n');

    var bad = crosslink.verifyWitnessFile(opts.witnessFile);
    assert.equal(bad.valid, false, 'rewritten witness must be detected');
    assert.equal(bad.brokenAt, 1);
  } finally { cleanup(dir); }
});

test('crosslink - dashboard unavailable is reported honestly, not false-pass', function (t) {
  var dir = makeTmpDir();
  try {
    var agentDir = path.join(dir, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    var log = new AuditLog({ logDir: agentDir });
    log.record({ who: 'agent-1', what: 'file_write' });
    log.flush();
    log.destroy();

    // Point at a non-existent audit.py so the dashboard side is unavailable.
    var opts = {
      logDir: agentDir,
      dashboardAuditDir: path.join(dir, 'nope'),
      auditPyPath: path.join(dir, 'does-not-exist-audit.py'),
      pythonBin: PYTHON,
      witnessFile: path.join(agentDir, 'witness.jsonl'),
      requireDashboard: true,
    };
    var result = crosslink.verifyUnified(opts);
    assert.equal(result.dashboard.available, false);
    assert.equal(result.valid, false, 'requireDashboard=true must fail when unavailable');

    // With requireDashboard=false, the agent chain alone still verifies.
    opts.requireDashboard = false;
    var result2 = crosslink.verifyUnified(opts);
    assert.equal(result2.agent.valid, true);
    assert.equal(result2.valid, true);
  } finally { cleanup(dir); }
});
