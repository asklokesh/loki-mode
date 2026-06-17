'use strict';

/**
 * Regression test: verifyManifestLink must detect trailing-truncation of
 * the agent audit chain via the append-only witness file's agentEntries
 * high-water mark.
 *
 * Threat model: an attacker edits .loki/loki-run.json AND truncates
 * .loki/audit/audit.jsonl to drop the trailing audit_manifest_link anchor.
 * The remaining prefix re-links cleanly from genesis (AuditLog.verifyChain
 * has no count anchor), so the chain verifies valid:true and -- with the
 * anchor gone -- verifyManifestLink used to return { valid:true,
 * present:false }. Any caller checking only `.valid` is fooled.
 *
 * The fix cross-checks the witness file's recorded agentEntries high-water
 * mark: a chain shorter than a previously-witnessed length is truncation,
 * so verifyManifestLink now reports valid:false + truncationSuspected:true.
 *
 * This test also proves NON-VACUITY: it reconstructs the OLD verification
 * logic (verifyChain + anchor-absent shortcut, no witness cross-check) and
 * asserts that the old logic DID return valid:true on the same truncated
 * chain. If the new code and the old code behaved identically, the test
 * would be meaningless; the non-vacuity assertion guarantees the new check
 * is what flips the verdict.
 *
 * Self-contained: builds its own chain + witness in a temp dir, cleans up.
 * Run: node tests/test-manifest-truncation.js
 */

var fs = require('fs');
var os = require('os');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var cl = require(path.join(ROOT, 'src', 'audit', 'crosslink'));
var AuditLog = require(path.join(ROOT, 'src', 'audit', 'log')).AuditLog;

var failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('  PASS: ' + msg);
  } else {
    console.error('  FAIL: ' + msg);
    failures++;
  }
}

// Reconstruct the OLD verifyManifestLink behavior (pre-fix): chain
// integrity + anchor-absent shortcut, with NO witness cross-check. Proves
// the truncated chain passed under the old logic (non-vacuity).
function oldVerifyManifestLink(opts) {
  var manifestPath = cl.defaultManifestPath(opts);
  var log = new AuditLog(opts);
  var chain = log.verifyChain();
  var entries = log.readEntries();
  log.destroy();
  var anchors = entries.filter(function (e) {
    return e.what === cl.MANIFEST_LINK_ACTION;
  });
  if (anchors.length === 0) {
    return { valid: !!chain.valid, present: false };
  }
  var anchor = anchors[anchors.length - 1];
  var pinned = (anchor.metadata && anchor.metadata.manifestSha256) || null;
  var current = cl.hashManifest(manifestPath);
  var ok = current.present && current.sha256 === pinned;
  return { valid: !!chain.valid && ok, present: true };
}

function main() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loki-manifest-trunc-'));
  try {
    var projectDir = dir;
    var logDir = path.join(dir, '.loki', 'audit');
    fs.mkdirSync(logDir, { recursive: true });
    var manifestPath = path.join(dir, '.loki', 'loki-run.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ schema: 'loki-run/v1', evidence: { tests: 'abc' } }));

    var opts = { logDir: logDir, projectDir: projectDir, manifestPath: manifestPath };

    // 1. Build a real chain: several work entries, then the manifest link.
    var log = new AuditLog(opts);
    for (var i = 0; i < 3; i++) {
      log.record({ who: 'agent', what: 'work', where: '.', why: 'build step ' + i, metadata: { step: i } });
    }
    log.flush();
    log.destroy();
    var linkRes = cl.linkManifest(opts);
    assert(linkRes.linked === true && linkRes.present === true,
      'manifest linked into chain');

    // 2. Witness the unified root -- captures the agentEntries high-water mark.
    var w = cl.writeWitness({ projectDir: projectDir, logDir: logDir });
    assert(w && w.record && typeof w.record.agentEntries === 'number' && w.record.agentEntries >= 4,
      'witness recorded agentEntries high-water mark (= ' + (w.record && w.record.agentEntries) + ')');

    // 3. Full chain verifies clean.
    var full = cl.verifyManifestLink(opts);
    assert(full.valid === true && full.present === true && full.truncationSuspected === false,
      'full chain: valid=true, present=true, truncationSuspected=false');

    // 4. ATTACK: edit the manifest AND truncate audit.jsonl below the
    //    witnessed length, dropping the trailing manifest-link anchor.
    var logFile = path.join(logDir, 'audit.jsonl');
    var lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert(lines.length === 4, 'pre-truncation chain has 4 lines (3 work + 1 anchor)');
    // Keep only the first 2 entries -> shorter, internally-consistent prefix,
    // manifest-link anchor dropped.
    fs.writeFileSync(logFile, lines.slice(0, 2).join('\n') + '\n');
    // Attacker also swaps the manifest contents.
    fs.writeFileSync(manifestPath, JSON.stringify({ schema: 'loki-run/v1', evidence: { tests: 'TAMPERED' } }));

    // 5. NON-VACUITY: the OLD logic is fooled -- truncated chain passes.
    var oldVerdict = oldVerifyManifestLink(opts);
    assert(oldVerdict.valid === true && oldVerdict.present === false,
      'NON-VACUITY: old logic returns valid=true, present=false on truncated chain (the bug)');

    // 6. THE FIX: the new logic detects the truncation and refuses to pass.
    var newVerdict = cl.verifyManifestLink(opts);
    assert(newVerdict.valid === false,
      'FIX: new verifyManifestLink returns valid=false on truncated chain');
    assert(newVerdict.truncationSuspected === true,
      'FIX: new verifyManifestLink flags truncationSuspected=true');
    assert(newVerdict.witness && newVerdict.witness.witnessedHighWater > newVerdict.witness.currentChainLength,
      'FIX: witnessedHighWater (' + (newVerdict.witness && newVerdict.witness.witnessedHighWater) +
      ') > currentChainLength (' + (newVerdict.witness && newVerdict.witness.currentChainLength) + ')');
    // A caller reading only .valid is now protected even though present:false.
    assert(newVerdict.present === false,
      'FIX: present is still honestly false (anchor was dropped), but valid is now false');

    // 7. CONTROL: with no witness file, a legitimately short chain must NOT
    //    false-trigger truncation (the guard only fires against a recorded
    //    high-water mark).
    var dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'loki-manifest-nowit-'));
    try {
      var logDir2 = path.join(dir2, '.loki', 'audit');
      fs.mkdirSync(logDir2, { recursive: true });
      var mp2 = path.join(dir2, '.loki', 'loki-run.json');
      fs.writeFileSync(mp2, JSON.stringify({ schema: 'loki-run/v1' }));
      var opts2 = { logDir: logDir2, projectDir: dir2, manifestPath: mp2 };
      var l2 = new AuditLog(opts2);
      l2.record({ who: 'agent', what: 'work', where: '.', why: 'one', metadata: {} });
      l2.flush(); l2.destroy();
      var noWit = cl.verifyManifestLink(opts2);
      assert(noWit.truncationSuspected === false,
        'CONTROL: no witness file -> truncationSuspected=false (no false positive)');
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures === 0) {
    console.log('\nALL ASSERTIONS PASSED');
    process.exit(0);
  } else {
    console.error('\n' + failures + ' ASSERTION(S) FAILED');
    process.exit(1);
  }
}

console.log('test-manifest-truncation: verifyManifestLink trailing-truncation detection');
main();
