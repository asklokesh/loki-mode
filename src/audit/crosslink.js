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
var MANIFEST_LINK_ACTION = 'audit_manifest_link';
var MANIFEST_FILE = 'loki-run.json';
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

/**
 * Resolve the path to the run manifest (bill-of-materials) written by
 * autonomy/run.sh at <project>/.loki/loki-run.json. Override via
 * opts.manifestPath for tests / non-standard layouts (mirrors the
 * explicit-override idiom used by witnessFile / dashboardAuditDir).
 */
function defaultManifestPath(opts) {
  opts = opts || {};
  if (opts.manifestPath) return opts.manifestPath;
  return path.join((opts.projectDir || process.cwd()), '.loki', MANIFEST_FILE);
}

/**
 * Hash the manifest exactly as run.sh's _loki_sha256 does: sha256 over the
 * raw file BYTES. We deliberately do NOT JSON.parse-then-re-stringify
 * (that would diverge from the on-disk bytes run.sh hashes and be fragile
 * to formatting). We additionally best-effort parse the bytes only to lift
 * the manifest `schema` field into anchor metadata; a malformed manifest
 * still hashes its bytes and records schema:null rather than aborting.
 *
 * @returns {object} { present, sha256, schema } -- present:false when the
 *   file is absent (no fabricated hash).
 */
function hashManifest(manifestPath) {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return { present: false, sha256: null, schema: null };
  }
  var buf = fs.readFileSync(manifestPath);
  var sha = crypto.createHash('sha256').update(buf).digest('hex');
  var schema = null;
  try {
    var parsed = JSON.parse(buf.toString('utf8'));
    if (parsed && typeof parsed.schema === 'string') schema = parsed.schema;
  } catch (_) { /* malformed manifest: hash bytes anyway, schema stays null */ }
  return { present: true, sha256: sha, schema: schema };
}

/**
 * Link the run manifest (loki-run.json, the build bill-of-materials) into
 * the agent audit chain so the manifest becomes tamper-evident and
 * verifiable against the evidence chain.
 *
 * The manifest already embeds sha256 hashes of the evidence files
 * (test_results, coverage, ...) computed by run.sh. By recording the
 * manifest's OWN byte-hash as an `audit_manifest_link` entry, the anchor
 * is protected by the agent chain's hash linkage, and the evidence hashes
 * inside the manifest become transitively tamper-evident (mutating the
 * manifest to point at different evidence changes its byte-hash, which no
 * longer matches the anchored hash; mutating the anchor breaks chain
 * verification). We hash the manifest itself only -- we do NOT re-hash the
 * evidence files here (run.sh already did, and the manifest pins them).
 *
 * HONEST behavior:
 *   - Manifest absent  -> no-op, returns { linked:false, present:false }.
 *     No fabricated link is recorded.
 *   - Manifest present -> hash recorded as an anchor; returns
 *     { linked:true, present:true, anchor, manifestSha256, ... }.
 *
 * Note: this records tamper-EVIDENCE (in-place edits are detected), not
 * tamper-PROOF against a full downstream chain rewrite -- that is what
 * writeWitness (external witness) is for.
 *
 * NOT auto-invoked from run.sh in this wave (integration is the run.sh
 * owner's territory). Intended call site: after run.sh writes
 * .loki/loki-run.json in build_completion_summary (autonomy/run.sh ~2895,
 * just after os.replace(tmp, out)), call
 *   node -e "require('./src/audit').linkManifest({projectDir:'<dir>'})"
 * (or the JS API audit.linkManifest()) on every terminal path.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectDir]   project dir for the agent log + manifest
 * @param {string} [opts.logDir]       explicit agent log dir (tests)
 * @param {string} [opts.manifestPath] explicit manifest path (tests)
 * @param {string} [opts.who]          actor recorded on the anchor
 * @returns {object}
 */
function linkManifest(opts) {
  opts = opts || {};
  var manifestPath = defaultManifestPath(opts);
  var h = hashManifest(manifestPath);
  if (!h.present) {
    return {
      linked: false, present: false, manifestPath: manifestPath,
      reason: 'run manifest absent (no-op)',
    };
  }
  var log = new AuditLog(opts);
  var anchor = log.record({
    who: opts.who || 'audit-manifest-link',
    what: MANIFEST_LINK_ACTION,
    where: manifestPath,
    why: 'link run manifest (bill-of-materials) into agent audit chain',
    metadata: {
      manifestPath: manifestPath,
      manifestSha256: h.sha256,
      manifestSchema: h.schema,
    },
  });
  log.flush();
  log.destroy();
  return {
    linked: true, present: true, manifestPath: manifestPath,
    manifestSha256: h.sha256, manifestSchema: h.schema, anchor: anchor,
  };
}

/**
 * Verify the run-manifest link against the evidence chain.
 *
 * Composes TWO checks (mirroring verifyUnified rather than a bare disk-vs
 * -recorded compare):
 *   1. Agent chain integrity (AuditLog.verifyChain()). This catches an
 *      edit to the ANCHOR entry itself (e.g. someone rewrites the recorded
 *      manifestSha256), not just an edit to the manifest file.
 *   2. Manifest reconciliation: re-hash the on-disk manifest and require
 *      it to equal the hash recorded by the MOST RECENT manifest-link
 *      anchor. A mutated manifest no longer matches -> tamper detected.
 *
 * HONEST empty cases (distinguishable from a real pass via `present`):
 *   - No anchor recorded yet -> { present:false, valid:true, reason:... }.
 *   - Anchor exists but the manifest file is now gone -> manifest.valid
 *     is false (the pinned manifest is missing/cannot be reconciled).
 *
 * @param {object} [opts] projectDir / logDir / manifestPath as linkManifest.
 * @returns {object} { valid, present, chain, manifest }
 */
function verifyManifestLink(opts) {
  opts = opts || {};
  var manifestPath = defaultManifestPath(opts);

  var log = new AuditLog(opts);
  var chain = log.verifyChain();
  var entries = log.readEntries();
  log.destroy();

  var anchors = entries.filter(function (e) {
    return e.what === MANIFEST_LINK_ACTION;
  });

  if (anchors.length === 0) {
    return {
      valid: !!chain.valid, present: false, chain: chain,
      manifest: { present: false, valid: true, reason: 'no manifest-link anchor recorded' },
    };
  }

  // Most recent anchor pins the current manifest state.
  var anchor = anchors[anchors.length - 1];
  var pinned = (anchor.metadata && anchor.metadata.manifestSha256) || null;

  var current = hashManifest(manifestPath);
  var manifest = {
    present: true,
    valid: true,
    manifestPath: manifestPath,
    pinnedSha256: pinned,
    currentSha256: current.sha256,
    anchorSeq: anchor.seq,
    error: null,
  };

  if (!current.present) {
    manifest.valid = false;
    manifest.error = 'manifest pinned by anchor seq ' + anchor.seq +
      ' is missing on disk';
  } else if (current.sha256 !== pinned) {
    manifest.valid = false;
    manifest.error = 'manifest hash mismatch at anchor seq ' + anchor.seq +
      ' (manifest tampered after linking)';
  }

  return {
    valid: !!chain.valid && manifest.valid,
    present: true,
    chain: chain,
    manifest: manifest,
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
  linkManifest: linkManifest,
  verifyManifestLink: verifyManifestLink,
  hashManifest: hashManifest,
  defaultManifestPath: defaultManifestPath,
  CROSSLINK_ACTION: CROSSLINK_ACTION,
  MANIFEST_LINK_ACTION: MANIFEST_LINK_ACTION,
};
