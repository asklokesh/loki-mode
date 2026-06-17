'use strict';
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var audit = require('../../src/audit');
var crosslink = require('../../src/audit/crosslink');

function mkTmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loki-manifest-link-test-'));
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ }
}

function manifestPathFor(dir) {
  return path.join(dir, '.loki', 'loki-run.json');
}

function writeManifest(dir, obj) {
  var p = manifestPathFor(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
}

// A manifest shaped like the one autonomy/run.sh writes (loki-run-manifest/v1).
function sampleManifest() {
  return {
    schema: 'loki-run-manifest/v1',
    loki_version: '7.51.0',
    timestamp: '2026-06-16T00:00:00Z',
    outcome: 'complete',
    iterations: 3,
    provider: 'claude',
    last_tier: 'sonnet',
    spec: { path: 'prd.md', sha256: 'a'.repeat(64) },
    git: { branch: 'main', start_sha: 'b'.repeat(40), head_sha: 'c'.repeat(40) },
    tool_versions: { node: 'v22.0.0', python: '3.12.0', git: '2.45.0', bun: '1.1.0' },
    evidence: {
      test_results: { path: '.loki/quality/test-results.json', exists: true, sha256: 'd'.repeat(64) },
      coverage: { path: '.loki/quality/coverage.json', exists: true, sha256: 'e'.repeat(64) },
      completion: { path: '.loki/state/completion.json', exists: true },
    },
  };
}

// --- 1. manifest present -> hash recorded + verify passes (non-vacuity) ---

test('linkManifest - manifest present: hash recorded and verify PASSES', function () {
  var dir = mkTmpProject();
  try {
    audit.destroy();
    audit.init(dir);
    writeManifest(dir, sampleManifest());

    var res = audit.linkManifest();
    assert.equal(res.linked, true);
    assert.equal(res.present, true);
    assert.match(res.manifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(res.manifestSchema, 'loki-run-manifest/v1');
    assert.ok(res.anchor);
    assert.equal(res.anchor.what, 'audit_manifest_link');

    // Recorded hash must equal a fresh byte-hash of the on-disk manifest.
    var fresh = crosslink.hashManifest(manifestPathFor(dir));
    assert.equal(res.manifestSha256, fresh.sha256);

    // Non-vacuity: untampered verify PASSES, on both the chain and manifest.
    var v = audit.verifyManifestLink();
    assert.equal(v.valid, true);
    assert.equal(v.present, true);
    assert.equal(v.chain.valid, true);
    assert.equal(v.manifest.valid, true);
    assert.equal(v.manifest.pinnedSha256, res.manifestSha256);
    assert.equal(v.manifest.currentSha256, res.manifestSha256);
    assert.equal(v.manifest.error, null);

    audit.destroy();
  } finally {
    audit.destroy();
    rmrf(dir);
  }
});

// --- 2. manifest tampered after recording -> verify FAILS ---

test('verifyManifestLink - manifest tampered after recording: verify FAILS', function () {
  var dir = mkTmpProject();
  try {
    audit.destroy();
    audit.init(dir);
    writeManifest(dir, sampleManifest());
    audit.linkManifest();

    // Sanity: passes before tamper (so the FAIL below is meaningful).
    assert.equal(audit.verifyManifestLink().valid, true);

    // Tamper: rewrite the manifest to point at different evidence.
    var tampered = sampleManifest();
    tampered.evidence.test_results.sha256 = 'f'.repeat(64);
    tampered.outcome = 'forged';
    writeManifest(dir, tampered);

    var v = audit.verifyManifestLink();
    assert.equal(v.valid, false);
    assert.equal(v.manifest.valid, false);
    assert.ok(v.manifest.error);
    assert.match(v.manifest.error, /tamper/i);
    // The agent chain itself was untouched -> chain stays valid; the
    // failure is isolated to the manifest reconciliation.
    assert.equal(v.chain.valid, true);

    audit.destroy();
  } finally {
    audit.destroy();
    rmrf(dir);
  }
});

// --- 2b. anchor tampered (chain) -> verify FAILS (composes chain integrity) ---

test('verifyManifestLink - anchor entry tampered: verify FAILS via chain', function () {
  var dir = mkTmpProject();
  try {
    audit.destroy();
    audit.init(dir);
    writeManifest(dir, sampleManifest());
    audit.linkManifest();
    audit.destroy();

    // Tamper the recorded anchor's pinned hash directly on disk.
    var chainFile = path.join(dir, '.loki', 'audit', 'audit.jsonl');
    var lines = fs.readFileSync(chainFile, 'utf8').trim().split('\n');
    var entry = JSON.parse(lines[lines.length - 1]);
    entry.metadata.manifestSha256 = '0'.repeat(64);
    lines[lines.length - 1] = JSON.stringify(entry);
    fs.writeFileSync(chainFile, lines.join('\n') + '\n', 'utf8');

    audit.init(dir);
    var v = audit.verifyManifestLink();
    assert.equal(v.valid, false);
    // Editing the anchor in place breaks the agent chain hash.
    assert.equal(v.chain.valid, false);
    audit.destroy();
  } finally {
    audit.destroy();
    rmrf(dir);
  }
});

// --- 3. manifest absent -> no-op honest ---

test('linkManifest - manifest absent: honest no-op (no fabricated link)', function () {
  var dir = mkTmpProject();
  try {
    audit.destroy();
    audit.init(dir);

    var res = audit.linkManifest();
    assert.equal(res.linked, false);
    assert.equal(res.present, false);
    assert.ok(res.reason);

    // No anchor was recorded -> nothing in the chain.
    var entries = audit.readEntries({ what: 'audit_manifest_link' });
    assert.equal(entries.length, 0);

    audit.destroy();
  } finally {
    audit.destroy();
    rmrf(dir);
  }
});

test('verifyManifestLink - no anchor recorded: honest empty (present:false)', function () {
  var dir = mkTmpProject();
  try {
    audit.destroy();
    audit.init(dir);

    var v = audit.verifyManifestLink();
    // Honest empty: distinguishable from a real pass via present:false.
    assert.equal(v.present, false);
    assert.equal(v.manifest.present, false);
    // No anchor + empty chain is honestly valid (nothing to contradict).
    assert.equal(v.valid, true);

    audit.destroy();
  } finally {
    audit.destroy();
    rmrf(dir);
  }
});

// --- 4. malformed manifest still hashes bytes (schema null), does not abort ---

test('linkManifest - malformed manifest: hashes bytes, schema null, verify passes', function () {
  var dir = mkTmpProject();
  try {
    audit.destroy();
    audit.init(dir);
    var p = manifestPathFor(dir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ this is not valid json', 'utf8');

    var res = audit.linkManifest();
    assert.equal(res.linked, true);
    assert.match(res.manifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(res.manifestSchema, null);

    assert.equal(audit.verifyManifestLink().valid, true);
    audit.destroy();
  } finally {
    audit.destroy();
    rmrf(dir);
  }
});

// --- 5. manifestPath override (testability idiom) ---

test('linkManifest - honors explicit manifestPath override', function () {
  var dir = mkTmpProject();
  try {
    var custom = path.join(dir, 'custom-manifest.json');
    fs.writeFileSync(custom, JSON.stringify(sampleManifest()), 'utf8');

    audit.destroy();
    audit.init(dir);
    var res = audit.linkManifest({ manifestPath: custom });
    assert.equal(res.linked, true);
    assert.equal(res.manifestPath, custom);

    var v = audit.verifyManifestLink({ manifestPath: custom });
    assert.equal(v.valid, true);
    audit.destroy();
  } finally {
    audit.destroy();
    rmrf(dir);
  }
});
