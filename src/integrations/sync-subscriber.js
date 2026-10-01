#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');

var lokiDir = process.env.LOKI_DIR || '.loki';
var pendingDir = path.join(process.cwd(), lokiDir, 'events', 'pending');
var lastProcessedFile = '';

// Integration adapters (initialized lazily based on env vars)
var integrations = [];

/**
 * Map RARV event types to integration sync status strings.
 * Static strings are used directly; functions receive the event payload
 * and return the appropriate status.
 */
var RARV_STATUS_MAP = {
  'iteration_start': 'building',
  'iteration_complete': function (payload) {
    return payload.status === 'completed' ? 'completed' : 'failed';
  },
  'session_start': 'planning',
  'session_end': function (payload) {
    return payload.result === '0' ? 'completed' : 'failed';
  },
  'phase_change': function (payload) {
    var phaseMap = {
      'REASON': 'planning',
      'ACT': 'building',
      'REFLECT': 'reviewing',
      'VERIFY': 'testing',
    };
    return phaseMap[payload.phase] || 'building';
  },
};

/**
 * Resolve RARV status from an event type and its payload.
 * Returns null when the event type is not recognized.
 *
 * @param {string} eventType - Event type string (e.g. 'phase_change')
 * @param {object} payload   - Event payload object
 * @returns {string|null}
 */
function resolveStatus(eventType, payload) {
  var mapper = RARV_STATUS_MAP[eventType];
  if (!mapper) return null;
  return typeof mapper === 'function' ? mapper(payload) : mapper;
}

/**
 * Build a details object from event data for integration dispatch.
 *
 * @param {object} data    - Full event object
 * @param {object} payload - Event payload (data.payload)
 * @returns {object}
 */
function buildDetails(data, payload) {
  return {
    iteration: payload.iteration,
    provider: payload.provider,
    phase: payload.phase || payload.action,
    timestamp: data.timestamp,
  };
}

/**
 * Initialize configured integrations based on environment variables.
 * Each integration that has the required env vars will be pushed
 * into the integrations array. Failures are logged but do not
 * prevent other integrations from loading.
 */
function initIntegrations() {
  // Jira
  var jiraVars = ['LOKI_JIRA_URL', 'LOKI_JIRA_EMAIL', 'LOKI_JIRA_TOKEN'];
  var jiraMissing = jiraVars.filter(function (k) { return !process.env[k]; });
  if (jiraMissing.length > 0 && jiraMissing.length < jiraVars.length) {
    console.error('[sync-subscriber] Jira not started, missing: ' + jiraMissing.join(', '));
  } else if (jiraMissing.length === 0) {
    try {
      var JiraApiClient = require('./jira/api-client').JiraApiClient;
      var JiraSyncManager = require('./jira/sync-manager').JiraSyncManager;
      var client = new JiraApiClient({
        baseUrl: process.env.LOKI_JIRA_URL,
        email: process.env.LOKI_JIRA_EMAIL,
        apiToken: process.env.LOKI_JIRA_TOKEN,
      });
      var syncManager = new JiraSyncManager({ apiClient: client });
      integrations.push({
        name: 'jira',
        epicKey: process.env.LOKI_JIRA_EPIC_KEY,
        syncManager: syncManager,
      });
      console.log('[sync-subscriber] Jira integration initialized');
    } catch (e) {
      console.error('[sync-subscriber] Failed to initialize Jira:', e.message);
    }
  }

  // Linear
  if (process.env.LOKI_LINEAR_TOKEN) {
    try {
      var LinearClient = require('./linear/client').LinearClient;
      var linearClient = new LinearClient(process.env.LOKI_LINEAR_TOKEN, {
        teamId: process.env.LOKI_LINEAR_TEAM_ID,
      });
      integrations.push({
        name: 'linear',
        projectId: process.env.LOKI_LINEAR_PROJECT_ID,
        client: linearClient,
      });
      console.log('[sync-subscriber] Linear integration initialized');
    } catch (e) {
      console.error('[sync-subscriber] Failed to initialize Linear:', e.message);
    }
  }

  // GitHub (sync mode)
  if (process.env.LOKI_GITHUB_SYNC === 'true') {
    try {
      var reporter = require('./github/reporter');
      integrations.push({
        name: 'github',
        reporter: reporter,
      });
      console.log('[sync-subscriber] GitHub sync integration initialized');
    } catch (e) {
      console.error('[sync-subscriber] Failed to initialize GitHub:', e.message);
    }
  }

  if (integrations.length === 0) {
    console.log('[sync-subscriber] No integrations configured, exiting');
    process.exit(0);
  }
}

/**
 * Parse and process a single event JSON file. Resolves the RARV status
 * and dispatches to all configured integrations using fire-and-forget.
 *
 * @param {string} filepath - Absolute path to the event JSON file
 */
function processEventFile(filepath) {
  try {
    var data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    var eventType = data.type;
    var payload = data.payload || {};

    var status = resolveStatus(eventType, payload);
    if (!status) return; // Not a RARV event we care about

    var details = buildDetails(data, payload);

    dispatchToIntegrations(status, details);
  } catch (e) {
    // Fire-and-forget: log but do not crash on bad event files
    if (e.code !== 'ENOENT') {
      console.error('[sync-subscriber] Error processing event file:', e.message);
    }
  }
}

/**
 * Dispatch a resolved status and details to all configured integrations.
 *
 * @param {string} status  - Resolved RARV status string
 * @param {object} details - Context details for the event
 */
function dispatchToIntegrations(status, details) {
  for (var i = 0; i < integrations.length; i++) {
    var integration = integrations[i];
    try {
      if (integration.name === 'jira' && integration.epicKey) {
        integration.syncManager.syncToJira(integration.epicKey, {
          phase: status,
          details: JSON.stringify(details),
        }).catch(function (e) {
          console.error('[sync-subscriber] Jira sync error:', e.message);
        });
      } else if (integration.name === 'linear' && integration.projectId) {
        if (integration.client.updateProjectStatus) {
          integration.client.updateProjectStatus(integration.projectId, status).catch(function (e) {
            console.error('[sync-subscriber] Linear sync error:', e.message);
          });
        }
      }
      // GitHub sync happens at session end via run.sh (sync_github_completed_tasks)
    } catch (e) {
      console.error('[sync-subscriber] Error dispatching to ' + integration.name + ':', e.message);
    }
  }
}

/**
 * Scan the pending events directory for new JSON files and process them.
 * Tracks already-processed filenames to avoid double-processing.
 * Prunes the tracking set when it grows beyond 10000 entries.
 */
function scanPendingEvents() {
  if (!fs.existsSync(pendingDir)) return;
  try {
    var files = fs.readdirSync(pendingDir)
      .filter(function(f) { return f.endsWith('.json'); })
      .sort();
    for (var i = 0; i < files.length; i++) {
      if (files[i] > lastProcessedFile) {
        processEventFile(path.join(pendingDir, files[i]));
        lastProcessedFile = files[i];
      }
    }
  } catch (e) { /* ignore */ }
}

// --- Main execution vs require ---

if (require.main === module) {
  initIntegrations();

  // Poll every 500ms
  var pollInterval = setInterval(scanPendingEvents, 500);

  // Initial scan
  scanPendingEvents();

  // Graceful shutdown
  function shutdown() {
    clearInterval(pollInterval);
    console.log('[sync-subscriber] Shutting down');
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Export internals for testing
module.exports = {
  RARV_STATUS_MAP: RARV_STATUS_MAP,
  resolveStatus: resolveStatus,
  buildDetails: buildDetails,
  processEventFile: processEventFile,
  dispatchToIntegrations: dispatchToIntegrations,
  scanPendingEvents: scanPendingEvents,
  initIntegrations: initIntegrations,
  // Expose mutable state for test manipulation
  _getIntegrations: function () { return integrations; },
  _setIntegrations: function (arr) { integrations = arr; },
  _getLastProcessedFile: function() { return lastProcessedFile; },
  _resetState: function() { lastProcessedFile = ''; },
  _setPendingDir: function (dir) { pendingDir = dir; },
};
