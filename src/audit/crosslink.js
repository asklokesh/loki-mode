'use strict';

/**
 * Loki Mode Audit Cross-Link (P3-9 unification).
 *
 * The system has two independent tamper-evident audit chains:
 *
 *   1. Agent chain  -- src/audit/log.js  (Node)
 *      file:   <project>/.loki/audit/audit.jsonl
 *      format: per-entry { ..., previousHash, hash }, genesis "GENESIS",
 *              hash = sha256(JSON of the linkable fields).
 *
 *   2. Dashboard chain -- dashboard/audit.py (Python)
 *      files:  ~/.loki/dashboard/audit/audit-YYYY-MM-DD.jsonl (+ rotations)
 *      format: per-entry { ..., _integrity_hash }, genesis "0"*64,
 *              hash = sha256(prev_hash + entry_json).
 *
 * They use different directories, file layouts, genesis values and hash
 * recipes, so a single physical chain is a large, risky merge. This
 * module instead implements a *verifiable cross-link*: it folds the
 * dashboard chain's current tip into the agent chain as an ordinary
 * `audit_crosslink` record (so the anchor itself is protected by the
 * agent chain's hash linkage), and ships a single `verifyUnified()`
 * command that validates BOTH sub-chains AND reconciles every anchor
 * against the live dashboard chain -- treating the pair as one logical,
 * tamper-evident trail.
 *
 * It also provides an append-only / external-witness OPTION
 * (`writeWitness`) so an external party can timestamp the unified root.
 *
 * Neither existing writer is modified or replaced: the agent writer
 * (AuditLog.record) and the dashboard writer (audit.log_event) keep
 * appending exactly as before. Full single-physical-chain unification
 * (shared hash recipe + shared storage) is documented as follow-up.
 */

var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');
var { execFileSync } = require('child_process');
var { AuditLog } = require('./log');

var CROSSLINK_ACTION = 'audit_crosslink';
var WITNESS_FILE = 'witness.jsonl';
var PY_GENESIS = '0'.repeat(64);

/**
 * Resolve the default dashboard (Python) audit directory.
 * Mirrors `AUDIT_DIR` in dashboard/audit.py: ~/.loki/dashboard/audit.
 */
function defaultDashboardAuditDir() {
  return path.join(os.homedir(), '.loki', 'dashboard', 'audit');
}

/**
 * Resolve the path to dashboard/audit.py. Allows override via opts for
 * tests and non-standard layouts; otherwise walks up from this file.
 */
function resolveAuditPy(opts) {
  if (opts && opts.auditPyPath) return opts.auditPyPath;
  // src/audit/crosslink.js -> repo root is two levels up from src/.
  var candidate = path.join(__dirname, '..', '..', 'dashboard', 'audit.py');
  return candidate;
}

/**
 * Resolve the python executable. Override via opts.pythonBin or env.
 */
function resolvePython(opts) {
  if (opts && opts.pythonBin) return opts.pythonBin;
  return process.env.LOKI_PYTHON || 'python3';
}

/**
 * Query the Python dashboard chain for its tip + verdict, by invoking
 * the audit.py CLI shim. Returns a structured object; on any failure
 * returns an `available:false` descriptor so the unified verifier can
 * still report on the agent chain alone (honest partial result).
 *
 * @param {object} [opts]
 * @param {string} [opts.dashboardAuditDir]
 * @param {string} [opts.auditPyPath]
 * @param {string} [opts.pythonBin]
 */
function dashboardChainTip(opts) {
  opts = opts || {};
  var dir = opts.dashboardAuditDir || defaultDashboardAuditDir();
  var py = resolvePython(opts);
  var script = resolveAuditPy(opts);
  if (!fs.existsSync(script)) {
    return { available: false, reason: 'audit.py not found at ' + script,
      tip_hash: PY_GENESIS, valid: false, entries: 0 };
  }
  try {
    var out = execFileSync(py, [script, 'tip', dir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    var parsed = JSON.parse(out.trim());
    parsed.available = true;
    return parsed;
  } catch (e) {
    // execFileSync throws on non-zero exit. The shim exits 1 when the
    // chain is INVALID but still prints valid JSON on stdout -- recover it.
    if (e && e.stdout) {
      try {
        var recovered = JSON.parse(String(e.stdout).trim());
        recovered.available = true;
        return recovered;
      } catch (_) { /* fall through */ }
    }
    return { available: false, reason: String((e && e.message) || e),
      tip_hash: PY_GENESIS, valid: false, entries: 0 };
  }
}

/**
 * Recompute the dashboard chain hash after exactly the first `nEntries`
 * integrity-bearing entries (the prefix pinned by a cross-link anchor),
 * by invoking the audit.py `prefix` shim. Lets the unified verifier tell
 * legitimate append-only GROWTH (prefix still reproduces the anchored
 * tip) from TAMPER (prefix no longer reproduces it).
 *
 * Returns { available, found, prefix_hash, entries_available }.
 */
function dashboardPrefixHash(nEntries, opts) {
  opts = opts || {};
  var dir = opts.dashboardAuditDir || defaultDashboardAuditDir();
  var py = resolvePython(opts);
  var script = resolveAuditPy(opts);
  if (!fs.existsSync(script)) {
    return { available: false, found: false, prefix_hash: PY_GENESIS,
      entries_available: 0 };
  }
  function parse(out) {
    var p = JSON.parse(String(out).trim());
    p.available = true;
    return p;
  }
  try {
    return parse(execFileSync(py, [script, 'prefix', dir, String(nEntries)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (e) {
    // Shim exits 1 (found:false) but still prints JSON on stdout.
    if (e && e.stdout) {
      try { return parse(e.stdout); } catch (_) { /* fall through */ }
    }
    return { available: false, found: false, prefix_hash: PY_GENESIS,
      entries_available: 0 };
  }
}

/**
 * Read the agent (JS) chain tip hash without recording anything.
 */
function agentChainTip(opts) {
  var log = new AuditLog(opts || {});
  // _loadChainTip ran in the constructor; expose the loaded tip + count.
  var tip = log._lastHash;
  var count = log._entryCount;
  return { tip_hash: tip, entries: count, chain_id: 'loki-agent-audit',
    genesis: 'GENESIS' };
}

/**
 * Compute the unified root: a deterministic hash binding both chain tips
 * together. This is the value an external witness timestamps.
 */
function unifiedRoot(agentTip, dashboardTip) {
  return crypto.createHash('sha256')
    .update('loki-unified-audit-v1\n' + agentTip + '\n' + dashboardTip)
    .digest('hex');
}

/**
 * Create a cross-link: fold the dashboard chain tip into the agent chain
 * as an `audit_crosslink` record. The anchor is therefore protected by
 * the agent chain's existing hash linkage (tampering with the anchor
 * breaks agent-chain verification), and it pins the dashboard chain
 * state at this point in time (tampering with already-anchored dashboard
 * history is caught by anchor reconciliation in verifyUnified).
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir]   project dir for the agent log
 * @param {string} [opts.logDir]       explicit agent log dir (tests)
 * @param {string} [opts.dashboardAuditDir]
 * @param {string} [opts.who]          actor recorded on the anchor
 * @returns {object} the recorded anchor entry plus dashboard verdict.
 */
function crossLink(opts) {
  opts = opts || {};
  var dash = dashboardChainTip(opts);
  var log = new AuditLog(opts);
  var agentTip = log._lastHash;
  var root = unifiedRoot(agentTip, dash.tip_hash || PY_GENESIS);
  var anchor = log.record({
    who: opts.who || 'audit-crosslink',
    what: CROSSLINK_ACTION,
    where: opts.dashboardAuditDir || defaultDashboardAuditDir(),
    why: 'cross-link dashboard audit chain into agent audit chain',
    metadata: {
      dashboardChainId: dash.chain_id || 'loki-dashboard-audit',
      dashboardTipHash: dash.tip_hash || PY_GENESIS,
      dashboardEntries: dash.entries || 0,
      dashboardValidAtLink: dash.available ? !!dash.valid : null,
      dashboardAvailable: !!dash.available,
      agentTipBeforeLink: agentTip,
      unifiedRoot: root,
    },
  });
  log.flush();
  log.destroy();
  return { anchor: anchor, dashboard: dash, unifiedRoot: root };
}

/**
 * Append-only / external-witness OPTION.
 *
 * Writes the current unified root to an append-only witness file (one
 * JSON line per witness, never rewritten). Optionally pipes the line to
 * an external witness command (opts.witnessCommand, e.g. a timestamping
 * authority or `tee` to a WORM mount) so an independent party holds an
 * out-of-band copy. Returns the witness record.
 *
 * @param {object} [opts]
 * @param {string} [opts.witnessFile]      path to the append-only file
 * @param {string} [opts.witnessCommand]   external command (argv[0])
 * @param {string[]} [opts.witnessArgs]    extra args for the command
 */
function writeWitness(opts) {
  opts = opts || {};
  var agent = agentChainTip(opts);
  var dash = dashboardChainTip(opts);
  var root = unifiedRoot(agent.tip_hash, dash.tip_hash || PY_GENESIS);
  var record = {
    type: 'loki-unified-audit-witness',
    timestamp: new Date().toISOString(),
    agentTipHash: agent.tip_hash,
    agentEntries: agent.entries,
    dashboardTipHash: dash.tip_hash || PY_GENESIS,
    dashboardEntries: dash.entries || 0,
    unifiedRoot: root,
  };
  var line = JSON.stringify(record);
  var witnessFile = opts.witnessFile ||
    path.join((opts.projectDir || process.cwd()), '.loki', 'audit', WITNESS_FILE);
  var witnessDir = path.dirname(witnessFile);
  if (!fs.existsSync(witnessDir)) fs.mkdirSync(witnessDir, { recursive: true });
  // Append-only: O_APPEND, never truncate or rewrite existing lines.
  fs.appendFileSync(witnessFile, line + '\n', { encoding: 'utf8', flag: 'a' });

  if (opts.witnessCommand) {
    try {
      execFileSync(opts.witnessCommand, (opts.witnessArgs || []).concat([line]), {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      record.externalWitness = true;
    } catch (e) {
      record.externalWitness = false;
      record.externalWitnessError = String((e && e.message) || e);
    }
  }
  return { record: record, witnessFile: witnessFile };
}

/**
 * Verify the witness file's own append-only continuity: each line must
 * parse, and (if present) line N's agent/dashboard entry counts must be
 * monotonic non-decreasing relative to line N-1. A shrinking count means
 * the file was rewritten / truncated.
 */
function verifyWitnessFile(witnessFile) {
  if (!witnessFile || !fs.existsSync(witnessFile)) {
    return { present: false, valid: true, witnesses: 0, brokenAt: null };
  }
  var content = fs.readFileSync(witnessFile, 'utf8').trim();
  if (!content) return { present: true, valid: true, witnesses: 0, brokenAt: null };
  var lines = content.split('\n');
  var prevAgent = -1;
  var prevDash = -1;
  for (var i = 0; i < lines.length; i++) {
    var rec;
    try { rec = JSON.parse(lines[i]); } catch (e) {
      return { present: true, valid: false, witnesses: i, brokenAt: i,
        error: 'invalid JSON at witness line ' + i };
    }
    var a = typeof rec.agentEntries === 'number' ? rec.agentEntries : 0;
    var d = typeof rec.dashboardEntries === 'number' ? rec.dashboardEntries : 0;
    if (a < prevAgent || d < prevDash) {
      return { present: true, valid: false, witnesses: i, brokenAt: i,
        error: 'witness counts went backwards at line ' + i +
          ' (append-only violated)' };
    }
    prevAgent = a;
    prevDash = d;
  }
  return { present: true, valid: true, witnesses: lines.length, brokenAt: null };
}

/**
 * Unified verification of the whole logical trail.
 *
 * Steps:
 *   1. Verify the agent (JS) chain via AuditLog.verifyChain().
 *   2. Verify the dashboard (Python) chain via audit.py.
 *   3. For each `audit_crosslink` anchor in the agent chain, reconcile:
 *        - the anchor's unifiedRoot must equal
 *          sha256(agentTipBeforeLink, dashboardTipHash);
 *        - the MOST RECENT anchor's dashboardTipHash must equal the live
 *          dashboard tip (catches post-link tampering / truncation of
 *          dashboard history). Older anchors pin historical tips and are
 *          allowed to differ from the live tip (the chain grew).
 *   4. (Optional) verify witness-file append-only continuity.
 *
 * The trail is `valid` only if every component that is present is valid.
 * If the dashboard side is unavailable (e.g. Python missing), it is
 * reported honestly as `available:false` and does not falsely pass.
 *
 * @param {object} [opts] same resolution opts as crossLink + optional
 *   opts.witnessFile and opts.requireDashboard (default true) and
 *   opts.requireCrosslink (default false).
 */
function verifyUnified(opts) {
  opts = opts || {};
  var requireDashboard = opts.requireDashboard !== false;
  var requireCrosslink = opts.requireCrosslink === true;

  var log = new AuditLog(opts);
  var agentResult = log.verifyChain();
  var entries = log.readEntries();
  log.destroy();

  var dash = dashboardChainTip(opts);

  // Reconcile cross-link anchors.
  //
  // For each anchor we check two things:
  //   1. The anchor's own unifiedRoot is internally consistent (it was
  //      not edited in place: unifiedRoot == H(agentTip, dashboardTip)).
  //      This is also protected by the agent chain hash, but checking it
  //      here gives a precise reconciliation error.
  //   2. The dashboard PREFIX the anchor pinned still reproduces. The
  //      dashboard chain is a live, continuously-appended log, so its
  //      live tip legitimately moves forward after a cross-link. Instead
  //      of comparing to the live tip (which would false-fail on every
  //      normal append), we recompute the hash of the first
  //      `dashboardEntries` entries and require it to equal the anchored
  //      `dashboardTipHash`. Append-only growth keeps that prefix intact;
  //      mutation at-or-before the anchor, or truncation below it, breaks
  //      reproducibility and is caught here.
  var anchors = entries.filter(function (e) { return e.what === CROSSLINK_ACTION; });
  var anchorReconcile = { count: anchors.length, valid: true, error: null };
  for (var i = 0; i < anchors.length; i++) {
    var m = anchors[i].metadata || {};
    var expectRoot = unifiedRoot(
      m.agentTipBeforeLink || '', m.dashboardTipHash || PY_GENESIS);
    if (m.unifiedRoot !== expectRoot) {
      anchorReconcile.valid = false;
      anchorReconcile.error = 'anchor unifiedRoot mismatch at seq ' + anchors[i].seq;
      break;
    }
    // Only reconcile the dashboard prefix when the dashboard side was
    // available at link time AND is available now. An anchor that
    // recorded an unavailable dashboard (dashboardAvailable=false) has
    // nothing to reconcile against.
    if (dash.available && m.dashboardAvailable) {
      var pinnedTip = m.dashboardTipHash || PY_GENESIS;
      var pinnedCount = typeof m.dashboardEntries === 'number' ? m.dashboardEntries : 0;
      var prefix = dashboardPrefixHash(pinnedCount, opts);
      if (!prefix.available || !prefix.found || prefix.prefix_hash !== pinnedTip) {
        anchorReconcile.valid = false;
        anchorReconcile.error =
          'dashboard prefix pinned by anchor seq ' + anchors[i].seq +
          ' no longer reproduces (history tampered or truncated below the link point)';
        break;
      }
    }
  }

  var witness = verifyWitnessFile(
    opts.witnessFile ||
    path.join((opts.projectDir || process.cwd()), '.loki', 'audit', WITNESS_FILE));

  var dashboardOk = dash.available ? !!dash.valid : !requireDashboard;
  var crosslinkOk = requireCrosslink ? anchors.length > 0 : true;

  var valid = !!agentResult.valid && dashboardOk && anchorReconcile.valid &&
    witness.valid && crosslinkOk;

  return {
    valid: valid,
    agent: agentResult,
    dashboard: dash,
    anchors: anchorReconcile,
    witness: witness,
    requireDashboard: requireDashboard,
    requireCrosslink: requireCrosslink,
  };
}

module.exports = {
  crossLink: crossLink,
  verifyUnified: verifyUnified,
  writeWitness: writeWitness,
  verifyWitnessFile: verifyWitnessFile,
  dashboardChainTip: dashboardChainTip,
  agentChainTip: agentChainTip,
  unifiedRoot: unifiedRoot,
  defaultDashboardAuditDir: defaultDashboardAuditDir,
  CROSSLINK_ACTION: CROSSLINK_ACTION,
};
