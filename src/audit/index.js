'use strict';

/**
 * Loki Mode Audit Trail - Public API
 *
 * Enterprise audit logging with tamper-evident hash chains,
 * compliance report generation, and data residency enforcement.
 *
 * Usage:
 *   var audit = require('./src/audit');
 *   audit.init('/path/to/project');
 *   audit.record({ who: 'agent-1', what: 'file_write', where: 'src/app.js', why: 'implement feature' });
 *   var result = audit.verifyChain();
 *   var report = audit.generateReport('soc2');
 *   var allowed = audit.checkProvider('anthropic', 'us');
 */

var { AuditLog } = require('./log');
var compliance = require('./compliance');
var { ResidencyController } = require('./residency');
var crosslink = require('./crosslink');

var _log = null;
var _residency = null;
var _initialized = false;
var _projectDir = null;

/**
 * Initialize the audit trail system.
 */
function init(projectDir) {
  var dir = projectDir || process.cwd();
  if (_initialized && _projectDir === dir) return;
  if (_initialized) destroy();

  _projectDir = dir;
  _log = new AuditLog({ projectDir: dir });
  _residency = new ResidencyController({ projectDir: dir });
  _initialized = true;
}

/**
 * Record an audit entry.
 */
function record(entry) {
  if (!_initialized) init();
  return _log.record(entry);
}

/**
 * Verify the hash chain integrity.
 */
function verifyChain() {
  if (!_initialized) init();
  return _log.verifyChain();
}

/**
 * Generate a compliance report.
 * @param {string} type - 'soc2', 'iso27001', or 'gdpr'
 * @param {object} [opts] - Report options
 */
function generateReport(type, opts) {
  if (!_initialized) init();
  var entries = _log.readEntries();
  switch (type) {
    case 'soc2':
      return compliance.generateSoc2Report(entries, opts);
    case 'iso27001':
      return compliance.generateIso27001Report(entries, opts);
    case 'gdpr':
      return compliance.generateGdprReport(entries, opts);
    default:
      throw new Error('Unknown report type: ' + type + '. Supported: soc2, iso27001, gdpr');
  }
}

/**
 * Export a report as JSON string.
 */
function exportReport(type, opts) {
  var report = generateReport(type, opts);
  return compliance.exportReportJson(report);
}

/**
 * Generate a compliance report as a plain object, with the agent-chain
 * tamper-evidence verdict folded in.
 *
 * This is the object form intended for surfaces (e.g. the dashboard
 * /api/compliance endpoint) that need the report as data rather than a
 * pre-serialized string. It always reflects the REAL audit chain:
 *
 *   - The report body is generated from the live audit entries
 *     (`_log.readEntries()`), never fabricated.
 *   - `chainIntegrity` is populated from `verifyChain()` so the report
 *     carries the true tamper-evidence state of the underlying chain.
 *     For the SOC2 report this fills the `chainIntegrity: null` slot the
 *     generator leaves for the caller; for the other report types it is
 *     attached under the same key for a uniform surface contract.
 *
 * When the chain has no entries the report is still returned honestly
 * with `totalAuditEntries: 0` (an empty-but-valid report), never a
 * fabricated "compliant" verdict.
 *
 * @param {string} type - 'soc2', 'iso27001', or 'gdpr'
 * @param {object} [opts] - Report options (projectName, period, etc.)
 * @returns {object} The compliance report object with chainIntegrity set.
 */
function getReport(type, opts) {
  if (!_initialized) init();
  var report = generateReport(type, opts);
  // Fold the real tamper-evidence verdict into the report. Do not let a
  // verification error fabricate a pass: capture it honestly instead.
  try {
    report.chainIntegrity = _log.verifyChain();
  } catch (e) {
    report.chainIntegrity = {
      valid: false,
      entries: report.totalAuditEntries || 0,
      brokenAt: null,
      error: 'chain verification failed: ' + String((e && e.message) || e),
    };
  }
  return report;
}

/**
 * CLI shim so a non-Node surface (e.g. the Python dashboard) can fetch a
 * compliance report for a given project directory as JSON on stdout.
 *
 * This mirrors the inverse of dashboard/audit.py's `_unified_cli()`
 * (which lets the Node-side unified verifier read the Python chain).
 *
 * Invoked as:
 *   node src/audit/index.js report <type> <projectDir>
 *
 * <type> is one of soc2 | iso27001 | gdpr. <projectDir> is the project
 * root whose .loki/audit/audit.jsonl chain is read. Prints a single JSON
 * object to stdout. Returns exit 0 on success, 2 on usage error.
 *
 * The report is generated from the REAL chain; an absent/empty chain
 * yields an honest empty report (totalAuditEntries: 0), not a fake pass.
 */
function _cli(argv) {
  var args = argv || [];
  var VALID_TYPES = { soc2: true, iso27001: true, gdpr: true };
  if (args.length < 2 || args[0] !== 'report' || !VALID_TYPES[args[1]]) {
    process.stdout.write(JSON.stringify({
      error: 'usage: index.js report {soc2|iso27001|gdpr} <projectDir>',
    }) + '\n');
    return 2;
  }
  var type = args[1];
  var projectDir = args[2] || process.cwd();
  destroy();
  init(projectDir);
  var report = getReport(type);
  destroy();
  process.stdout.write(JSON.stringify(report) + '\n');
  return 0;
}

/**
 * Check if a provider is allowed by data residency policy.
 */
function checkProvider(provider, region) {
  if (!_initialized) init();
  return _residency.checkProvider(provider, region);
}

/**
 * Check if air-gapped mode is enabled.
 */
function isAirGapped() {
  if (!_initialized) init();
  return _residency.isAirGapped();
}

/**
 * Read filtered audit entries.
 */
function readEntries(filter) {
  if (!_initialized) init();
  return _log.readEntries(filter);
}

/**
 * Get audit log summary.
 */
function getSummary() {
  if (!_initialized) init();
  return _log.getSummary();
}

/**
 * Flush pending entries to disk.
 */
function flush() {
  if (_log) _log.flush();
}

/**
 * Cross-link the dashboard (Python) audit chain into the agent (JS)
 * audit chain, producing a single verifiable tamper-evident trail.
 * See src/audit/crosslink.js.
 */
function crossLink(opts) {
  if (!_initialized) init();
  return crosslink.crossLink(Object.assign({ projectDir: _projectDir }, opts || {}));
}

/**
 * Verify the unified (agent + dashboard) audit trail as one logical
 * chain: both sub-chains valid AND every cross-link anchor reconciled.
 */
function verifyUnified(opts) {
  if (!_initialized) init();
  return crosslink.verifyUnified(Object.assign({ projectDir: _projectDir }, opts || {}));
}

/**
 * Append-only / external-witness option: write the current unified root
 * to an append-only witness file (and optionally an external command).
 */
function writeWitness(opts) {
  if (!_initialized) init();
  return crosslink.writeWitness(Object.assign({ projectDir: _projectDir }, opts || {}));
}

/**
 * Destroy audit trail (for testing).
 */
function destroy() {
  if (_log) _log.destroy();
  _log = null;
  _residency = null;
  _initialized = false;
  _projectDir = null;
}

module.exports = {
  init: init,
  record: record,
  verifyChain: verifyChain,
  generateReport: generateReport,
  exportReport: exportReport,
  getReport: getReport,
  checkProvider: checkProvider,
  isAirGapped: isAirGapped,
  readEntries: readEntries,
  getSummary: getSummary,
  flush: flush,
  destroy: destroy,
  crossLink: crossLink,
  verifyUnified: verifyUnified,
  writeWitness: writeWitness,
};

// CLI entry point: `node src/audit/index.js report <type> <projectDir>`.
if (require.main === module) {
  process.exit(_cli(process.argv.slice(2)));
}
