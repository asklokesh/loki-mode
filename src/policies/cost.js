'use strict';

/**
 * Loki Mode Policy Engine - Cost Control System
 *
 * Per-project token budget tracking with configurable alert thresholds, plus
 * organization/tenant-level spend rollup and ceiling enforcement.
 *
 * Features:
 *   - Per-project token budget tracking
 *   - Alerts at configurable thresholds (default: 50%, 80%, 100%)
 *   - Per-agent cost tracking (model type, tokens consumed, duration)
 *   - Kill switch: emits shutdown event when budget exceeded
 *   - Org/tenant-level rollup: aggregates spend across all projects under an org
 *   - Org ceiling: pause or deny when aggregate org spend crosses a hard cap
 *   - Cost data persisted to .loki/state/costs.json
 *
 * Org governance is an intelligent default: it is OFF (zero overhead, existing
 * per-run behavior unchanged) unless an org ceiling is configured via an
 * `org_max_tokens` resource policy. When configured, the org context is
 * auto-detected (no required flags) from, in priority order:
 *   1. explicit `org_id` on the resource policy
 *   2. LOKI_ORG_ID / LOKI_TENANT_ID environment variables
 *   3. the git remote owner (org/user) of the project directory
 *   4. the literal 'default'
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');

// -------------------------------------------------------------------
// CostController class
// -------------------------------------------------------------------

/** Maximum entries per project in state file to prevent unbounded growth. */
const MAX_STATE_ENTRIES = 10000;

class CostController extends EventEmitter {
  /**
   * @param {string} projectDir - Root directory containing .loki/
   * @param {Array} resourcePolicies - Resource policy entries from engine
   */
  constructor(projectDir, resourcePolicies) {
    super();
    this._projectDir = projectDir || process.cwd();
    this._stateFile = path.join(this._projectDir, '.loki', 'state', 'costs.json');
    this._state = this._loadState();
    this._budgetConfig = this._extractBudgetConfig(resourcePolicies || []);
    this._orgConfig = this._extractOrgConfig(resourcePolicies || []);
    this._triggeredAlerts = new Set();
    // Per-project shutdown flags (keyed by projectId or 'global').
    // Using a Set instead of a single boolean ensures each project only
    // emits shutdown once even when multiple projects are tracked.
    this._shutdownEmittedProjects = new Set();
    // Per-org shutdown flags (keyed by orgId). Mirrors the per-project set so
    // each org enforces its ceiling at most once per controller lifetime.
    this._shutdownEmittedOrgs = new Set();

    // Resolve the org id once. Cheap when org governance is off (we still
    // resolve so rollups are attributed, but ceiling logic is a no-op).
    this._orgId = this._orgConfig ? this._detectOrgId() : null;

    // Restore previously triggered alerts
    if (this._state.triggeredAlerts) {
      for (let i = 0; i < this._state.triggeredAlerts.length; i++) {
        this._triggeredAlerts.add(this._state.triggeredAlerts[i]);
      }
    }
  }

  // -----------------------------------------------------------------
  // State persistence
  // -----------------------------------------------------------------

  _loadState() {
    try {
      if (fs.existsSync(this._stateFile)) {
        const raw = fs.readFileSync(this._stateFile, 'utf8');
        return JSON.parse(raw);
      }
    } catch (_) {
      // Corrupted file -- start fresh
    }
    return {
      projects: {},
      agents: {},
      orgs: {},
      totalTokens: 0,
      triggeredAlerts: [],
      history: [],
    };
  }

  _saveState() {
    const dir = path.dirname(this._stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this._state.triggeredAlerts = Array.from(this._triggeredAlerts);
    fs.writeFileSync(this._stateFile, JSON.stringify(this._state, null, 2), 'utf8');
  }

  _extractBudgetConfig(resourcePolicies) {
    for (let i = 0; i < resourcePolicies.length; i++) {
      const p = resourcePolicies[i];
      if (p.max_tokens) {
        return {
          maxTokens: p.max_tokens,
          alerts: p.alerts || [50, 80, 100],
          onExceed: p.on_exceed || 'shutdown',
          name: p.name,
        };
      }
    }
    return null;
  }

  /**
   * Extract org/tenant ceiling config from resource policies.
   *
   * An org policy is any resource entry that declares `org_max_tokens`. This is
   * intentionally separate from per-run `max_tokens` so the two ceilings can
   * coexist (a run can be capped per-project AND roll up into an org cap).
   *
   * Returns null when no org ceiling is configured -- org governance stays off
   * and per-run behavior is byte-for-byte unchanged.
   *
   * @param {Array} resourcePolicies
   * @returns {{ maxTokens: number, alerts: Array<number>, onExceed: string,
   *             name: string, orgId: (string|null) }|null}
   */
  _extractOrgConfig(resourcePolicies) {
    for (let i = 0; i < resourcePolicies.length; i++) {
      const p = resourcePolicies[i];
      if (p && typeof p.org_max_tokens === 'number' && p.org_max_tokens > 0) {
        return {
          maxTokens: p.org_max_tokens,
          alerts: p.org_alerts || p.alerts || [50, 80, 100],
          // Org ceilings default to 'pause' (deny new spend) rather than a hard
          // shutdown, so a single project cannot tear down the whole org. Both
          // 'pause' and 'shutdown' deny further spend; 'warn' is advisory only.
          onExceed: p.org_on_exceed || 'pause',
          name: p.name || 'org-budget',
          orgId: typeof p.org_id === 'string' && p.org_id ? p.org_id : null,
        };
      }
    }
    return null;
  }

  /**
   * Auto-detect the org/tenant id with zero required configuration.
   * Priority: explicit policy org_id > env > git remote owner > 'default'.
   *
   * @returns {string}
   */
  _detectOrgId() {
    if (this._orgConfig && this._orgConfig.orgId) {
      return this._orgConfig.orgId;
    }
    const envId = process.env.LOKI_ORG_ID || process.env.LOKI_TENANT_ID;
    if (envId && String(envId).trim()) {
      return String(envId).trim();
    }
    const remoteOwner = this._detectGitRemoteOwner();
    if (remoteOwner) {
      return remoteOwner;
    }
    return 'default';
  }

  /**
   * Best-effort extraction of the owner segment from the project's git origin
   * remote (e.g. "acme" from git@github.com:acme/repo.git). Returns null on any
   * failure -- never throws, never blocks cost recording.
   *
   * @returns {string|null}
   */
  _detectGitRemoteOwner() {
    try {
      const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
        cwd: this._projectDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!url) return null;
      // Strip protocol/host and trailing .git, then take the owner segment.
      // Handles: git@host:owner/repo.git, https://host/owner/repo(.git), ssh://...
      let p = url.replace(/\.git$/, '');
      const scp = p.match(/^[^@]+@[^:]+:(.+)$/); // scp-like syntax
      if (scp) {
        p = scp[1];
      } else {
        p = p.replace(/^[a-z]+:\/\/[^/]+\//i, '');
      }
      const segments = p.split('/').filter(Boolean);
      if (segments.length >= 2) {
        return segments[segments.length - 2];
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  // -----------------------------------------------------------------
  // Token recording
  // -----------------------------------------------------------------

  /**
   * Record tokens consumed by an agent.
   *
   * @param {string} projectId - Project identifier
   * @param {object} usage - { agentId, model, tokens, durationMs }
   */
  recordUsage(projectId, usage) {
    const { agentId, model, tokens, durationMs } = usage || {};
    const tokenCount = tokens || 0;

    // Update project totals
    if (!this._state.projects[projectId]) {
      this._state.projects[projectId] = { totalTokens: 0, entries: [] };
    }
    this._state.projects[projectId].totalTokens += tokenCount;
    this._state.projects[projectId].entries.push({
      agentId: agentId || 'unknown',
      model: model || 'unknown',
      tokens: tokenCount,
      durationMs: durationMs || 0,
      timestamp: new Date().toISOString(),
    });

    // Update agent totals
    const agentKey = agentId || 'unknown';
    if (!this._state.agents[agentKey]) {
      this._state.agents[agentKey] = { totalTokens: 0, model: model, entries: 0 };
    }
    this._state.agents[agentKey].totalTokens += tokenCount;
    this._state.agents[agentKey].entries += 1;

    // Update global total
    this._state.totalTokens += tokenCount;

    // Org/tenant rollup (only when an org ceiling is configured). The rollup
    // aggregates this project's spend into the org's running total and records
    // which projects contribute, so operators can see cross-project spend.
    if (this._orgConfig) {
      if (!this._state.orgs) this._state.orgs = {};
      const orgId = this._orgId || 'default';
      if (!this._state.orgs[orgId]) {
        this._state.orgs[orgId] = { totalTokens: 0, projects: {} };
      }
      const org = this._state.orgs[orgId];
      org.totalTokens += tokenCount;
      const pid = projectId || 'unknown';
      org.projects[pid] = (org.projects[pid] || 0) + tokenCount;
    }

    // Check alerts and budget
    this._checkAlerts(projectId);

    // Check org ceiling (no-op when org governance is off)
    this._checkOrgCeiling();

    this._saveState();
  }

  // -----------------------------------------------------------------
  // Budget checking
  // -----------------------------------------------------------------

  /**
   * Check the budget status for a project (or globally).
   *
   * @param {string} [projectId] - Project identifier (if omitted, checks global)
   * @returns {{ remaining: number, percentage: number, alerts: Array, exceeded: boolean }}
   */
  checkBudget(projectId) {
    if (!this._budgetConfig) {
      return {
        remaining: Infinity,
        percentage: 0,
        alerts: [],
        exceeded: false,
      };
    }

    const consumed = projectId && this._state.projects[projectId]
      ? this._state.projects[projectId].totalTokens
      : this._state.totalTokens;

    const max = this._budgetConfig.maxTokens;
    const percentage = max > 0 ? Math.round((consumed / max) * 100) : 0;
    const remaining = Math.max(0, max - consumed);
    const exceeded = consumed >= max;

    // Collect active alerts
    const alerts = [];
    const thresholds = this._budgetConfig.alerts;
    for (let i = 0; i < thresholds.length; i++) {
      if (percentage >= thresholds[i]) {
        alerts.push({
          threshold: thresholds[i],
          message: 'Token usage at ' + percentage + '% (threshold: ' + thresholds[i] + '%)',
        });
      }
    }

    return { remaining, percentage, alerts, exceeded };
  }

  /**
   * Check the aggregate org/tenant budget status.
   *
   * Rolls up spend across every project attributed to the org and compares it
   * against the configured org ceiling. When no org ceiling is configured this
   * returns an unlimited, never-exceeded result so callers can treat the org
   * gate as transparently absent.
   *
   * @param {string} [orgId] - Org identifier (defaults to the auto-detected org)
   * @returns {{ orgId: (string|null), consumed: number, remaining: number,
   *             percentage: number, alerts: Array, exceeded: boolean,
   *             decision: string }}
   */
  checkOrgBudget(orgId) {
    if (!this._orgConfig) {
      return {
        orgId: null,
        consumed: 0,
        remaining: Infinity,
        percentage: 0,
        alerts: [],
        exceeded: false,
        decision: 'allow',
      };
    }

    const id = orgId || this._orgId || 'default';
    const org = this._state.orgs && this._state.orgs[id];
    const consumed = org ? org.totalTokens : 0;

    const max = this._orgConfig.maxTokens;
    const percentage = max > 0 ? Math.round((consumed / max) * 100) : 0;
    const remaining = Math.max(0, max - consumed);
    const exceeded = consumed >= max;

    const alerts = [];
    const thresholds = this._orgConfig.alerts;
    for (let i = 0; i < thresholds.length; i++) {
      if (percentage >= thresholds[i]) {
        alerts.push({
          threshold: thresholds[i],
          message: 'Org token usage at ' + percentage + '% (threshold: ' + thresholds[i] + '%)',
        });
      }
    }

    // Decision: 'warn' never blocks; 'pause'/'shutdown' deny once exceeded.
    let decision = 'allow';
    if (exceeded && this._orgConfig.onExceed !== 'warn') {
      decision = this._orgConfig.onExceed === 'shutdown' ? 'deny' : 'pause';
    }

    return { orgId: id, consumed, remaining, percentage, alerts, exceeded, decision };
  }

  _checkOrgCeiling() {
    if (!this._orgConfig) return;

    const orgId = this._orgId || 'default';
    const budget = this.checkOrgBudget(orgId);

    // Emit alert events for newly triggered org thresholds (deduped per org).
    const thresholds = this._orgConfig.alerts;
    for (let i = 0; i < thresholds.length; i++) {
      const key = 'org:' + orgId + ':' + thresholds[i];
      if (budget.percentage >= thresholds[i] && !this._triggeredAlerts.has(key)) {
        this._triggeredAlerts.add(key);

        this._pushHistory({
          type: 'org_alert',
          threshold: thresholds[i],
          percentage: budget.percentage,
          orgId: orgId,
          consumed: budget.consumed,
          max: this._orgConfig.maxTokens,
          timestamp: new Date().toISOString(),
        });

        this.emit('org_alert', {
          threshold: thresholds[i],
          percentage: budget.percentage,
          orgId: orgId,
          remaining: budget.remaining,
        });
      }
    }

    // Ceiling enforcement: pause/deny when the org aggregate is exceeded.
    // 'warn' is advisory and never blocks. Each org enforces at most once.
    if (budget.exceeded
      && this._orgConfig.onExceed !== 'warn'
      && !this._shutdownEmittedOrgs.has(orgId)) {
      this._shutdownEmittedOrgs.add(orgId);

      this._pushHistory({
        type: 'org_ceiling_exceeded',
        decision: budget.decision,
        reason: 'Org budget exceeded',
        percentage: budget.percentage,
        orgId: orgId,
        consumed: budget.consumed,
        max: this._orgConfig.maxTokens,
        timestamp: new Date().toISOString(),
      });

      this._saveState();
      this.emit('org_ceiling', {
        reason: 'Org token budget exceeded',
        decision: budget.decision,
        orgId: orgId,
        percentage: budget.percentage,
        consumed: budget.consumed,
        max: this._orgConfig.maxTokens,
      });
    }
  }

  /** Append a history record with bounded growth. */
  _pushHistory(record) {
    if (this._state.history.length > MAX_STATE_ENTRIES) {
      this._state.history.splice(0, this._state.history.length - MAX_STATE_ENTRIES);
    }
    this._state.history.push(record);
  }

  _checkAlerts(projectId) {
    if (!this._budgetConfig) return;

    const budget = this.checkBudget(projectId);

    // Emit alert events for newly triggered thresholds
    const thresholds = this._budgetConfig.alerts;
    for (let i = 0; i < thresholds.length; i++) {
      const key = (projectId || 'global') + ':' + thresholds[i];
      if (budget.percentage >= thresholds[i] && !this._triggeredAlerts.has(key)) {
        this._triggeredAlerts.add(key);

        if (this._state.history.length > MAX_STATE_ENTRIES) {
      this._state.history.splice(0, this._state.history.length - MAX_STATE_ENTRIES);
    }
    this._state.history.push({
          type: 'alert',
          threshold: thresholds[i],
          percentage: budget.percentage,
          projectId: projectId || 'global',
          timestamp: new Date().toISOString(),
        });

        this.emit('alert', {
          threshold: thresholds[i],
          percentage: budget.percentage,
          projectId: projectId,
          remaining: budget.remaining,
        });
      }
    }

    // Kill switch (per-project: each project emits shutdown at most once)
    const shutdownKey = projectId || 'global';
    if (budget.exceeded && !this._shutdownEmittedProjects.has(shutdownKey)) {
      if (this._budgetConfig.onExceed === 'shutdown') {
        this._shutdownEmittedProjects.add(shutdownKey);

        if (this._state.history.length > MAX_STATE_ENTRIES) {
      this._state.history.splice(0, this._state.history.length - MAX_STATE_ENTRIES);
    }
    this._state.history.push({
          type: 'shutdown',
          reason: 'Budget exceeded',
          percentage: budget.percentage,
          projectId: projectId || 'global',
          timestamp: new Date().toISOString(),
        });

        this._saveState();
        this.emit('shutdown', {
          reason: 'Token budget exceeded',
          projectId: projectId,
          percentage: budget.percentage,
          consumed: this._state.totalTokens,
          max: this._budgetConfig.maxTokens,
        });
      }
    }
  }

  // -----------------------------------------------------------------
  // Reporting
  // -----------------------------------------------------------------

  /**
   * Get per-agent cost report.
   */
  getAgentReport() {
    return Object.assign({}, this._state.agents);
  }

  /**
   * Get per-project cost report.
   */
  getProjectReport(projectId) {
    if (projectId) {
      return this._state.projects[projectId] || null;
    }
    return Object.assign({}, this._state.projects);
  }

  /**
   * Get the org/tenant rollup report.
   *
   * @param {string} [orgId] - When given, returns that org's rollup (or null);
   *                           otherwise returns a copy of all org rollups.
   */
  getOrgReport(orgId) {
    const orgs = this._state.orgs || {};
    if (orgId) {
      return orgs[orgId] || null;
    }
    return Object.assign({}, orgs);
  }

  /**
   * Get the history of alerts and shutdown events.
   */
  getHistory() {
    return this._state.history.slice();
  }

  /**
   * Reset all cost tracking data.
   */
  reset() {
    this._state = {
      projects: {},
      agents: {},
      orgs: {},
      totalTokens: 0,
      triggeredAlerts: [],
      history: [],
    };
    this._triggeredAlerts.clear();
    this._shutdownEmittedProjects.clear();
    this._shutdownEmittedOrgs.clear();
    this._saveState();
  }
}

// -------------------------------------------------------------------
// Exports
// -------------------------------------------------------------------

module.exports = { CostController };
