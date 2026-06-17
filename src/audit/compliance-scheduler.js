'use strict';

/**
 * Compliance snapshot scheduler (lightweight helper, NOT a daemon).
 *
 * v7.53.0 shipped a live GET /api/compliance endpoint that regenerates a
 * compliance report on demand. This module is the remaining P3-11 piece:
 * OPTIONAL scheduled/continuous generation so a compliance snapshot is
 * periodically PERSISTED to disk. That gives two things a live dashboard
 * call cannot:
 *
 *   1. Trend / history: a series of timestamped snapshots over time.
 *   2. Air-gapped audit evidence: durable, self-contained proof on disk
 *      without anyone making a live API call.
 *
 * It is deliberately NOT a background process. The gate function
 * (maybeGenerateSnapshot) is meant to be invoked opportunistically (for
 * example once per autonomous run) and self-rate-limits: it only writes a
 * new snapshot when the configured interval has elapsed since the last one.
 * That makes it "continuous" when enabled without needing a daemon or any
 * always-running loop.
 *
 * HONESTY: every snapshot is generated from the REAL current audit chain
 * (AuditLog.readEntries) and the REAL tamper-evidence verdict
 * (AuditLog.verifyChain), exactly like index.js getReport. An empty chain
 * yields an honest empty snapshot (totalAuditEntries: 0), never a
 * fabricated "compliant" verdict.
 *
 * DEFAULT DISABLED: with no configured interval (LOKI_COMPLIANCE_SNAPSHOT_INTERVAL_HOURS
 * unset or 0), maybeGenerateSnapshot is a no-op and adds zero behavior for
 * existing users.
 *
 * NOT YET AUTO-INVOKED: this wave ships the tested helper only. It is not
 * wired into run.sh or any live loop here (that is integration, owned by the
 * run.sh owners). See "How to invoke" below for the intended call site.
 *
 * How to invoke (intended integration, not yet wired):
 *   var scheduler = require('./src/audit/compliance-scheduler');
 *   // Once per run, after init:
 *   scheduler.maybeGenerateSnapshot({ projectDir: process.cwd() });
 *   // Reads LOKI_COMPLIANCE_SNAPSHOT_INTERVAL_HOURS; no-op unless elapsed.
 */

var fs = require('fs');
var path = require('path');
var { AuditLog } = require('./log');
var compliance = require('./compliance');

var ENV_INTERVAL = 'LOKI_COMPLIANCE_SNAPSHOT_INTERVAL_HOURS';
var SNAPSHOT_DIRNAME = 'compliance-snapshots';
var MARKER_FILENAME = 'last-snapshot.json';
var MS_PER_HOUR = 3600 * 1000;

/**
 * Parse a configured interval (hours) into a number. Returns 0 (disabled)
 * for unset, empty, non-numeric, negative, or NaN values. 0 means the
 * scheduler is disabled and maybeGenerateSnapshot is a no-op.
 *
 * @param {*} raw - Raw value (typically process.env.LOKI_COMPLIANCE_SNAPSHOT_INTERVAL_HOURS)
 * @returns {number} Interval in hours, or 0 if disabled / invalid.
 */
function parseIntervalHours(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  var n = Number(raw);
  if (!isFinite(n) || n <= 0) return 0;
  return n;
}

/**
 * Resolve the snapshot directory for a project: <projectDir>/.loki/audit/compliance-snapshots.
 */
function snapshotDir(projectDir) {
  return path.join(projectDir || process.cwd(), '.loki', 'audit', SNAPSHOT_DIRNAME);
}

/**
 * Resolve the rate-limit marker file path.
 */
function markerPath(projectDir) {
  return path.join(snapshotDir(projectDir), MARKER_FILENAME);
}

/**
 * Read the last-generated timestamp (ms) from the marker file. Returns null
 * if no marker exists or it is unreadable / malformed (treated as "never
 * generated" so the next call generates).
 */
function readLastGeneratedAtMs(projectDir) {
  var p = markerPath(projectDir);
  try {
    if (!fs.existsSync(p)) return null;
    var raw = fs.readFileSync(p, 'utf8');
    var obj = JSON.parse(raw);
    var ms = Number(obj && obj.lastGeneratedAtMs);
    if (!isFinite(ms)) return null;
    return ms;
  } catch (_) {
    return null;
  }
}

/**
 * Build a compliance snapshot from the REAL audit chain for a project.
 *
 * Bundles all three report types (soc2, iso27001, gdpr), each generated
 * from the live audit entries, plus the single shared tamper-evidence
 * verdict. This mirrors index.js getReport's honesty: the chainIntegrity
 * verdict comes from verifyChain(), and a verification error is recorded
 * as a valid:false verdict rather than being allowed to throw or fabricate
 * a pass. An empty chain produces totalAuditEntries: 0 honestly.
 *
 * This does NOT use the index.js singleton; it reads the chain directly so
 * it is self-contained and free of shared-state coupling.
 *
 * @param {object} args
 * @param {string} args.projectDir - Project root whose .loki/audit chain is read.
 * @param {object} [args.reportOpts] - Options forwarded to the generators (projectName, period, etc.)
 * @param {number} [args.nowMs] - Clock for generatedAt (defaults to Date.now()).
 * @returns {object} The snapshot object.
 */
function buildSnapshot(args) {
  args = args || {};
  var projectDir = args.projectDir || process.cwd();
  var reportOpts = args.reportOpts || {};
  var nowMs = (typeof args.nowMs === 'number') ? args.nowMs : Date.now();

  var log = new AuditLog({ projectDir: projectDir });
  var entries;
  try {
    entries = log.readEntries();
  } catch (e) {
    entries = [];
  }

  // Real tamper-evidence verdict. Do not let a verification error fabricate
  // a pass: capture it honestly as a valid:false verdict instead.
  var chainIntegrity;
  try {
    chainIntegrity = log.verifyChain();
  } catch (e) {
    chainIntegrity = {
      valid: false,
      entries: entries.length,
      brokenAt: null,
      error: 'chain verification failed: ' + String((e && e.message) || e),
    };
  }

  try { log.destroy(); } catch (_) { /* noop */ }

  var soc2 = compliance.generateSoc2Report(entries, reportOpts);
  soc2.chainIntegrity = chainIntegrity;
  var iso27001 = compliance.generateIso27001Report(entries, reportOpts);
  iso27001.chainIntegrity = chainIntegrity;
  var gdpr = compliance.generateGdprReport(entries, reportOpts);
  gdpr.chainIntegrity = chainIntegrity;

  return {
    snapshotVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    projectName: reportOpts.projectName || 'Loki Mode',
    totalAuditEntries: entries.length,
    chainIntegrity: chainIntegrity,
    reports: {
      soc2: soc2,
      iso27001: iso27001,
      gdpr: gdpr,
    },
  };
}

/**
 * Build a filesystem-safe snapshot filename from an ISO timestamp. ISO
 * strings contain colons and dots which are fine on macOS/Linux but are
 * sanitized to hyphens anyway for portability.
 */
function snapshotFilename(isoTimestamp) {
  var safe = String(isoTimestamp).replace(/[:.]/g, '-');
  return 'compliance-' + safe + '.json';
}

/**
 * Persist a snapshot to disk and update the rate-limit marker.
 *
 * Writes <snapshotDir>/compliance-<timestamp>.json and updates
 * <snapshotDir>/last-snapshot.json with the generation clock so the next
 * gate decision reads the same clock that produced the snapshot.
 *
 * @param {object} args
 * @param {string} args.projectDir - Project root.
 * @param {object} args.snapshot - Snapshot object (from buildSnapshot).
 * @param {number} args.nowMs - Generation clock in ms (stored in the marker).
 * @returns {string} The absolute path of the written snapshot file.
 */
function persistSnapshot(args) {
  var projectDir = args.projectDir || process.cwd();
  var snapshot = args.snapshot;
  var nowMs = args.nowMs;
  var dir = snapshotDir(projectDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  var file = path.join(dir, snapshotFilename(snapshot.generatedAt));
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');
  fs.writeFileSync(
    markerPath(projectDir),
    JSON.stringify({ lastGeneratedAtMs: nowMs, lastSnapshotFile: path.basename(file) }, null, 2),
    'utf8'
  );
  return file;
}

/**
 * Opportunistic, self-rate-limiting snapshot generation.
 *
 * Decides whether to generate a snapshot now based on the configured
 * interval and the persisted last-generated timestamp:
 *
 *   - Interval 0 / unset (default) -> no-op, reason 'disabled'.
 *   - No prior snapshot and interval > 0 -> generate (first run).
 *   - now - lastGeneratedAt >= interval -> generate.
 *   - Otherwise -> no-op, reason 'not-elapsed'.
 *
 * Both the interval and the clock are injectable via opts so callers (and
 * tests) can control them; env is the fallback for the interval and
 * Date.now() the fallback for the clock.
 *
 * Return contract:
 *   { generated: true, path: <file>, report: <snapshot>, intervalHours }
 *   { generated: false, reason: 'disabled', intervalHours: 0 }
 *   { generated: false, reason: 'not-elapsed', intervalHours, nextEligibleAtMs }
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir] - Project root (default process.cwd()).
 * @param {number} [opts.intervalHours] - Interval override; falls back to env.
 * @param {number} [opts.now] - Current time in ms; falls back to Date.now().
 * @param {object} [opts.reportOpts] - Options forwarded to report generators.
 * @returns {object} Result per the return contract above.
 */
function maybeGenerateSnapshot(opts) {
  opts = opts || {};
  var projectDir = opts.projectDir || process.cwd();
  var intervalHours = (typeof opts.intervalHours === 'number')
    ? parseIntervalHours(opts.intervalHours)
    : parseIntervalHours(process.env[ENV_INTERVAL]);
  var now = (typeof opts.now === 'number') ? opts.now : Date.now();

  if (intervalHours <= 0) {
    return { generated: false, reason: 'disabled', intervalHours: 0 };
  }

  var lastMs = readLastGeneratedAtMs(projectDir);
  var intervalMs = intervalHours * MS_PER_HOUR;

  if (lastMs !== null && (now - lastMs) < intervalMs) {
    return {
      generated: false,
      reason: 'not-elapsed',
      intervalHours: intervalHours,
      nextEligibleAtMs: lastMs + intervalMs,
    };
  }

  var snapshot = buildSnapshot({
    projectDir: projectDir,
    reportOpts: opts.reportOpts,
    nowMs: now,
  });
  var file = persistSnapshot({ projectDir: projectDir, snapshot: snapshot, nowMs: now });

  return {
    generated: true,
    path: file,
    report: snapshot,
    intervalHours: intervalHours,
  };
}

module.exports = {
  maybeGenerateSnapshot: maybeGenerateSnapshot,
  buildSnapshot: buildSnapshot,
  persistSnapshot: persistSnapshot,
  parseIntervalHours: parseIntervalHours,
  snapshotDir: snapshotDir,
  markerPath: markerPath,
  ENV_INTERVAL: ENV_INTERVAL,
};
