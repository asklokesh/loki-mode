'use strict';

/**
 * GitHub Actions Trigger Context Handler
 *
 * Parses GitHub webhook event payloads and extracts the relevant
 * context for Loki Mode execution. Works both inside GitHub Actions
 * (with GITHUB_TOKEN) and standalone (with configured PAT).
 */

/**
 * Allowed provider values. The workflow_dispatch REST API can supply any
 * string even when the YAML declares a choice type, so we validate here.
 */
var ALLOWED_PROVIDERS = ['claude', 'codex', 'gemini'];

/**
 * Label-to-configuration mapping.
 * GitHub labels on issues/PRs can control Loki Mode behavior.
 */
const LABEL_CONFIG_MAP = {
  'loki-mode': { enabled: true },
  'loki-priority-high': { priority: 'high' },
  'loki-priority-low': { priority: 'low' },
  'loki-provider-codex': { provider: 'codex' },
  'loki-provider-gemini': { provider: 'gemini' },
  'loki-dry-run': { dryRun: true },
};

/**
 * Parse trigger context from a GitHub event.
 *
 * @param {Object} options
 * @param {string} options.eventName - GitHub event name (issues, pull_request_review, schedule, workflow_dispatch)
 * @param {Object} options.payload - GitHub event payload (parsed JSON)
 * @param {Object} [options.inputs] - workflow_dispatch inputs
 * @returns {Object} Structured trigger context for Loki Mode
 */
function parseTriggerContext(options) {
  const { eventName, payload, inputs } = options;

  switch (eventName) {
    case 'issues':
      return parseIssueEvent(payload);
    case 'pull_request_review':
      return parsePullRequestReviewEvent(payload);
    case 'schedule':
      return parseScheduleEvent(payload);
    case 'workflow_dispatch':
      return parseWorkflowDispatchEvent(payload, inputs);
    default:
      return {
        triggerType: 'unknown',
        prd: '',
        provider: 'claude',
        dryRun: false,
        sourceId: null,
        sourceType: null,
        labels: [],
        metadata: { eventName },
      };
  }
}

/**
 * Parse an issue labeled event.
 * Extracts PRD content from the issue body.
 *
 * @param {Object} payload - GitHub issues event payload
 * @returns {Object} Trigger context
 */
function parseIssueEvent(payload) {
  const issue = payload.issue || {};
  const label = payload.label || {};
  const labels = (issue.labels || []).map(function (l) {
    return typeof l === 'string' ? l : l.name;
  });

  const config = mapLabelsToConfig(labels);

  return {
    triggerType: 'issue',
    prd: extractPrdFromBody(issue.body || ''),
    provider: config.provider || 'claude',
    dryRun: config.dryRun || false,
    sourceId: String(issue.number || ''),
    sourceType: 'issue',
    labels: labels,
    metadata: {
      issueNumber: issue.number,
      issueTitle: issue.title || '',
      issueUrl: issue.html_url || '',
      triggerLabel: label.name || '',
      author: (issue.user || {}).login || '',
      repository: (payload.repository || {}).full_name || '',
    },
  };
}

/**
 * Parse a pull_request_review event.
 * Extracts context from the PR description.
 *
 * @param {Object} payload - GitHub pull_request_review event payload
 * @returns {Object} Trigger context
 */
function parsePullRequestReviewEvent(payload) {
  const pr = payload.pull_request || {};
  const review = payload.review || {};
  const labels = (pr.labels || []).map(function (l) {
    return typeof l === 'string' ? l : l.name;
  });

  const config = mapLabelsToConfig(labels);

  return {
    triggerType: 'pull_request_review',
    prd: extractPrdFromBody(pr.body || ''),
    provider: config.provider || 'claude',
    dryRun: config.dryRun || false,
    sourceId: String(pr.number || ''),
    sourceType: 'pull_request',
    labels: labels,
    metadata: {
      prNumber: pr.number,
      prTitle: pr.title || '',
      prUrl: pr.html_url || '',
      prHead: (pr.head || {}).ref || '',
      prBase: (pr.base || {}).ref || '',
      reviewState: review.state || '',
      reviewAuthor: (review.user || {}).login || '',
      author: (pr.user || {}).login || '',
      repository: (payload.repository || {}).full_name || '',
    },
  };
}

/**
 * Parse a schedule event.
 *
 * @param {Object} payload - GitHub schedule event payload
 * @returns {Object} Trigger context
 */
function parseScheduleEvent(payload) {
  return {
    triggerType: 'schedule',
    prd: '',
    provider: 'claude',
    dryRun: false,
    sourceId: null,
    sourceType: null,
    labels: [],
    metadata: {
      schedule: (payload || {}).schedule || '',
      repository: (payload.repository || {}).full_name || '',
    },
  };
}

/**
 * Parse a workflow_dispatch event.
 *
 * @param {Object} payload - GitHub workflow_dispatch event payload
 * @param {Object} inputs - Workflow dispatch inputs
 * @returns {Object} Trigger context
 */
function parseWorkflowDispatchEvent(payload, inputs) {
  const prdContent = (inputs || {}).prd_content || '';
  // Validate provider against the allowed set to prevent shell metacharacter injection.
  // The GitHub UI enforces the choice constraint but the REST API does not.
  var rawProvider = (inputs || {}).provider || 'claude';
  var provider = ALLOWED_PROVIDERS.indexOf(rawProvider) !== -1 ? rawProvider : 'claude';
  const dryRun = (inputs || {}).dry_run === true || (inputs || {}).dry_run === 'true';

  return {
    triggerType: 'workflow_dispatch',
    prd: prdContent,
    provider: provider,
    dryRun: dryRun,
    sourceId: null,
    sourceType: null,
    labels: [],
    metadata: {
      sender: ((payload || {}).sender || {}).login || '',
      repository: ((payload || {}).repository || {}).full_name || '',
    },
  };
}

/**
 * Extract PRD content from an issue or PR body.
 * Looks for content between PRD markers, or uses the full body
 * if no markers are found.
 *
 * Supported markers:
 *   <!-- PRD_START --> ... <!-- PRD_END -->
 *   ```prd ... ```
 *   ## PRD ... (until next ## heading or end)
 *
 * @param {string} body - Issue or PR body text
 * @returns {string} Extracted PRD content
 */
function extractPrdFromBody(body) {
  if (!body || typeof body !== 'string') {
    return '';
  }

  // Try HTML comment markers first
  var commentMatch = body.match(/<!--\s*PRD_START\s*-->([\s\S]*?)<!--\s*PRD_END\s*-->/i);
  if (commentMatch) {
    return commentMatch[1].trim();
  }

  // Try fenced code block with prd language
  var codeMatch = body.match(/```prd\s*\n([\s\S]*?)```/i);
  if (codeMatch) {
    return codeMatch[1].trim();
  }

  // Try PRD section header.
  // Do NOT use the /m flag here: with /m, the $ anchor matches end-of-line instead
  // of end-of-string, causing the regex to stop at the first blank line inside the
  // section rather than at the next ## heading or the real end of the document.
  var sectionMatch = body.match(/(?:^|\n)##\s+PRD\s*\n([\s\S]*?)(?=\n##\s|\s*$)/i);
  if (sectionMatch) {
    return sectionMatch[1].trim();
  }

  // Fall back to the full body
  return body.trim();
}

/**
 * Map GitHub labels to Loki Mode configuration options.
 *
 * @param {string[]} labels - Array of label names
 * @returns {Object} Merged configuration from matching labels
 */
function mapLabelsToConfig(labels) {
  var config = {};
  if (!Array.isArray(labels)) {
    return config;
  }

  labels.forEach(function (label) {
    var mapping = LABEL_CONFIG_MAP[label];
    if (mapping) {
      Object.keys(mapping).forEach(function (key) {
        config[key] = mapping[key];
      });
    }
  });

  return config;
}

module.exports = {
  parseTriggerContext: parseTriggerContext,
  parseIssueEvent: parseIssueEvent,
  parsePullRequestReviewEvent: parsePullRequestReviewEvent,
  parseScheduleEvent: parseScheduleEvent,
  parseWorkflowDispatchEvent: parseWorkflowDispatchEvent,
  extractPrdFromBody: extractPrdFromBody,
  mapLabelsToConfig: mapLabelsToConfig,
  LABEL_CONFIG_MAP: LABEL_CONFIG_MAP,
  ALLOWED_PROVIDERS: ALLOWED_PROVIDERS,
};
