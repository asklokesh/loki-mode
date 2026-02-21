'use strict';

/**
 * GitHub Results Reporter
 *
 * Posts Loki Mode execution results back to GitHub as PR comments,
 * issue comments, and status checks. Works both inside GitHub Actions
 * (with GITHUB_TOKEN) and standalone (with configured PAT).
 *
 * Uses only Node.js built-in https module for GitHub REST API calls.
 */

var https = require('https');
var fs = require('fs');
var path = require('path');

/**
 * Post execution results to GitHub based on the trigger event type.
 *
 * @param {Object} options
 * @param {string} options.eventName - GitHub event name
 * @param {Object} options.payload - GitHub event payload
 * @param {string} options.status - Execution status (success, failure, unknown)
 * @param {string} options.executionId - Unique execution identifier
 * @param {string} options.repository - Repository full name (owner/repo)
 * @param {string} options.sha - Commit SHA for status checks
 * @param {string} options.serverUrl - GitHub server URL
 * @param {string} options.runId - GitHub Actions run ID
 * @param {string} options.token - GitHub token (GITHUB_TOKEN or PAT)
 * @param {string} [options.reportsPath] - Path to .loki/reports directory
 */
async function postResults(options) {
  var eventName = options.eventName;
  var payload = options.payload;
  var token = options.token;

  if (!token) {
    throw new Error('GitHub token is required. Set GITHUB_TOKEN or provide a PAT.');
  }

  var report = loadReport(options.reportsPath);

  switch (eventName) {
    case 'pull_request_review':
      await postPrComment(options, report);
      await createStatusCheck(options, report);
      break;
    case 'issues':
      await postIssueComment(options, report);
      break;
    case 'workflow_dispatch':
    case 'schedule':
      // For manual and scheduled triggers, create a status check on the SHA
      await createStatusCheck(options, report);
      break;
    default:
      console.log('No reporting action for event:', eventName);
  }
}

/**
 * Post a quality report comment on a pull request.
 *
 * @param {Object} options - Same as postResults options
 * @param {Object} report - Parsed report data
 */
async function postPrComment(options, report) {
  var pr = (options.payload || {}).pull_request || {};
  var prNumber = pr.number;

  if (!prNumber) {
    console.log('No PR number found in payload, skipping PR comment.');
    return;
  }

  var body = renderQualityReport(report, options);
  var parts = options.repository.split('/');
  var owner = parts[0];
  var repo = parts[1];

  await githubApiRequest({
    method: 'POST',
    path: '/repos/' + owner + '/' + repo + '/issues/' + prNumber + '/comments',
    token: options.token,
    body: { body: body },
  });

  console.log('Posted quality report to PR #' + prNumber);
}

/**
 * Post an execution summary comment on an issue.
 *
 * @param {Object} options - Same as postResults options
 * @param {Object} report - Parsed report data
 */
async function postIssueComment(options, report) {
  var issue = (options.payload || {}).issue || {};
  var issueNumber = issue.number;

  if (!issueNumber) {
    console.log('No issue number found in payload, skipping issue comment.');
    return;
  }

  var body = renderExecutionSummary(report, options);
  var parts = options.repository.split('/');
  var owner = parts[0];
  var repo = parts[1];

  await githubApiRequest({
    method: 'POST',
    path: '/repos/' + owner + '/' + repo + '/issues/' + issueNumber + '/comments',
    token: options.token,
    body: { body: body },
  });

  console.log('Posted execution summary to issue #' + issueNumber);
}

/**
 * Create a GitHub commit status check.
 *
 * @param {Object} options - Same as postResults options
 * @param {Object} report - Parsed report data
 */
async function createStatusCheck(options, report) {
  var sha = options.sha;
  if (!sha) {
    console.log('No SHA available, skipping status check.');
    return;
  }

  var parts = options.repository.split('/');
  var owner = parts[0];
  var repo = parts[1];

  var state = options.status === 'success' ? 'success' : 'failure';
  var description = options.status === 'success'
    ? 'Loki Mode execution completed successfully'
    : 'Loki Mode execution completed with errors';

  var targetUrl = options.serverUrl + '/' + options.repository + '/actions/runs/' + options.runId;

  await githubApiRequest({
    method: 'POST',
    path: '/repos/' + owner + '/' + repo + '/statuses/' + sha,
    token: options.token,
    body: {
      state: state,
      target_url: targetUrl,
      description: description,
      context: 'loki-mode/enterprise',
    },
  });

  console.log('Created status check on commit ' + sha.substring(0, 7) + ': ' + state);
}

/**
 * Load execution report from the reports directory.
 *
 * @param {string} [reportsPath] - Path to .loki/reports
 * @returns {Object} Parsed report data with defaults
 */
function loadReport(reportsPath) {
  var report = {
    qualityGates: [],
    tasksCompleted: 0,
    tasksFailed: 0,
    totalTasks: 0,
    duration: 'unknown',
    deploymentUrl: null,
    summary: 'No detailed report available.',
  };

  if (!reportsPath) {
    return report;
  }

  // Try to load quality gate results
  var qualityPath = path.join(reportsPath, 'quality-gates.json');
  if (fs.existsSync(qualityPath)) {
    try {
      var qualityData = JSON.parse(fs.readFileSync(qualityPath, 'utf8'));
      report.qualityGates = qualityData.gates || qualityData || [];
    } catch (e) {
      console.log('Warning: Could not parse quality-gates.json:', e.message);
    }
  }

  // Try to load execution summary
  var summaryPath = path.join(reportsPath, 'summary.json');
  if (fs.existsSync(summaryPath)) {
    try {
      var summaryData = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      report.tasksCompleted = summaryData.tasksCompleted || 0;
      report.tasksFailed = summaryData.tasksFailed || 0;
      report.totalTasks = summaryData.totalTasks || 0;
      report.duration = summaryData.duration || 'unknown';
      report.deploymentUrl = summaryData.deploymentUrl || null;
      report.summary = summaryData.summary || report.summary;
    } catch (e) {
      console.log('Warning: Could not parse summary.json:', e.message);
    }
  }

  return report;
}

/**
 * Render quality report markdown for PR comments.
 *
 * @param {Object} report - Parsed report data
 * @param {Object} options - Execution options
 * @returns {string} Formatted markdown
 */
function renderQualityReport(report, options) {
  var templatePath = path.join(__dirname, 'templates', 'quality-report.md');
  var template = '';

  if (fs.existsSync(templatePath)) {
    template = fs.readFileSync(templatePath, 'utf8');
  } else {
    template = getDefaultQualityReportTemplate();
  }

  return applyTemplate(template, report, options);
}

/**
 * Render execution summary markdown for issue comments.
 *
 * @param {Object} report - Parsed report data
 * @param {Object} options - Execution options
 * @returns {string} Formatted markdown
 */
function renderExecutionSummary(report, options) {
  var templatePath = path.join(__dirname, 'templates', 'execution-summary.md');
  var template = '';

  if (fs.existsSync(templatePath)) {
    template = fs.readFileSync(templatePath, 'utf8');
  } else {
    template = getDefaultExecutionSummaryTemplate();
  }

  return applyTemplate(template, report, options);
}

/**
 * Escape a string value before inserting it into a markdown context.
 * Strips characters that can break markdown structure in inline positions:
 * backticks, square brackets, parentheses, and bare newlines in
 * single-line fields. For multi-line fields (summary, gates details)
 * only bracket/paren pairs that could create unintended links are escaped.
 *
 * @param {string} value - Raw user-controlled string
 * @param {boolean} [multiline] - Allow newlines (default false)
 * @returns {string} Escaped string safe for markdown inline use
 */
function escapeMarkdown(value, multiline) {
  if (typeof value !== 'string') {
    return String(value);
  }
  // Replace characters that have structural meaning in markdown
  var escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
  if (!multiline) {
    // Collapse newlines to a space for single-line fields
    escaped = escaped.replace(/[\r\n]+/g, ' ');
  }
  return escaped;
}

/**
 * Validate a URL is safe to use as a markdown link target.
 * Only https:// URLs are allowed to prevent javascript: and data: injection.
 *
 * @param {string} url - URL to validate
 * @returns {boolean}
 */
function isSafeUrl(url) {
  return typeof url === 'string' && /^https:\/\//i.test(url);
}

/**
 * Apply template variables to a markdown template string.
 * Uses a single-pass global regex replace to prevent infinite loops when
 * a replacement value itself contains a placeholder key.
 *
 * @param {string} template - Template with {{variable}} placeholders
 * @param {Object} report - Report data
 * @param {Object} options - Execution options
 * @returns {string} Rendered template
 */
function applyTemplate(template, report, options) {
  var statusLabel = options.status === 'success' ? 'PASS' : 'FAIL';

  // Build quality gates table rows - escape user-controlled gate name and details
  var gatesRows = '';
  if (Array.isArray(report.qualityGates) && report.qualityGates.length > 0) {
    gatesRows = report.qualityGates.map(function (gate) {
      var gateStatus = gate.passed ? 'PASS' : 'FAIL';
      return '| ' + escapeMarkdown(gate.name || 'Unknown') + ' | ' + gateStatus + ' | ' + escapeMarkdown(gate.details || '-') + ' |';
    }).join('\n');
  } else {
    gatesRows = '| No quality gate data available | - | - |';
  }

  // Only render deployment URL as a link when it is a safe https:// URL
  var deploymentLine;
  if (report.deploymentUrl && isSafeUrl(report.deploymentUrl)) {
    deploymentLine = '[View Deployment](' + report.deploymentUrl + ')';
  } else if (report.deploymentUrl) {
    // URL exists but is not safe - render as plain escaped text
    deploymentLine = escapeMarkdown(report.deploymentUrl);
  } else {
    deploymentLine = 'N/A';
  }

  var runUrl = (options.serverUrl || '') + '/' + (options.repository || '') + '/actions/runs/' + (options.runId || '');

  var replacements = {
    '{{STATUS}}': statusLabel,
    '{{EXECUTION_ID}}': escapeMarkdown(options.executionId || 'unknown'),
    '{{TASKS_COMPLETED}}': String(report.tasksCompleted),
    '{{TASKS_FAILED}}': String(report.tasksFailed),
    '{{TOTAL_TASKS}}': String(report.totalTasks),
    '{{DURATION}}': escapeMarkdown(report.duration || 'unknown'),
    '{{QUALITY_GATES_TABLE}}': gatesRows,
    '{{DEPLOYMENT_URL}}': deploymentLine,
    '{{RUN_URL}}': runUrl,
    '{{SUMMARY}}': escapeMarkdown(report.summary || 'No summary available.', true),
    '{{REPOSITORY}}': escapeMarkdown(options.repository || ''),
    '{{SHA}}': escapeMarkdown((options.sha || '').substring(0, 7)),
  };

  // Single-pass replacement: build one regex that matches any placeholder key
  // and resolves it from the replacements map. This prevents infinite loops
  // when a replacement value itself contains a placeholder key (e.g. {{STATUS}}
  // inside a summary string), which the old while-loop approach would re-expand.
  var result = template.replace(/\{\{[A-Z_]+\}\}/g, function (key) {
    return Object.prototype.hasOwnProperty.call(replacements, key)
      ? replacements[key]
      : key;
  });

  return result;
}

/**
 * Default quality report template (used if template file is missing).
 *
 * @returns {string} Template string
 */
function getDefaultQualityReportTemplate() {
  return [
    '## Loki Mode Quality Report',
    '',
    '**Status:** {{STATUS}} | **Execution:** `{{EXECUTION_ID}}`',
    '',
    '### Quality Gates',
    '',
    '| Gate | Status | Details |',
    '|------|--------|---------|',
    '{{QUALITY_GATES_TABLE}}',
    '',
    '### Summary',
    '',
    '- Tasks: {{TASKS_COMPLETED}}/{{TOTAL_TASKS}} completed, {{TASKS_FAILED}} failed',
    '- Duration: {{DURATION}}',
    '- Deployment: {{DEPLOYMENT_URL}}',
    '',
    '---',
    '[View full run]({{RUN_URL}}) | Commit: `{{SHA}}`',
  ].join('\n');
}

/**
 * Default execution summary template (used if template file is missing).
 *
 * @returns {string} Template string
 */
function getDefaultExecutionSummaryTemplate() {
  return [
    '## Loki Mode Execution Summary',
    '',
    '**Status:** {{STATUS}} | **Execution:** `{{EXECUTION_ID}}`',
    '',
    '### Results',
    '',
    '{{SUMMARY}}',
    '',
    '### Metrics',
    '',
    '- Tasks completed: {{TASKS_COMPLETED}}/{{TOTAL_TASKS}}',
    '- Tasks failed: {{TASKS_FAILED}}',
    '- Duration: {{DURATION}}',
    '',
    '---',
    '[View full run]({{RUN_URL}})',
  ].join('\n');
}

/**
 * Make a request to the GitHub REST API.
 *
 * @param {Object} options
 * @param {string} options.method - HTTP method
 * @param {string} options.path - API path (e.g., /repos/owner/repo/issues/1/comments)
 * @param {string} options.token - Authentication token
 * @param {Object} [options.body] - Request body (will be JSON stringified)
 * @returns {Promise<Object>} Parsed response body
 */
function githubApiRequest(options) {
  return new Promise(function (resolve, reject) {
    var bodyStr = options.body ? JSON.stringify(options.body) : '';

    var reqOptions = {
      hostname: 'api.github.com',
      port: 443,
      path: options.path,
      method: options.method,
      headers: {
        'Authorization': 'token ' + options.token,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'loki-mode-enterprise',
        'Content-Type': 'application/json',
      },
    };

    if (bodyStr) {
      reqOptions.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    var req = https.request(reqOptions, function (res) {
      var data = '';
      res.on('data', function (chunk) {
        data += chunk;
      });
      res.on('end', function () {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch (e) {
            resolve({});
          }
        } else {
          reject(new Error('GitHub API error ' + res.statusCode + ': ' + data));
        }
      });
    });

    req.on('error', function (err) {
      reject(err);
    });

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

module.exports = {
  postResults: postResults,
  postPrComment: postPrComment,
  postIssueComment: postIssueComment,
  createStatusCheck: createStatusCheck,
  loadReport: loadReport,
  renderQualityReport: renderQualityReport,
  renderExecutionSummary: renderExecutionSummary,
  applyTemplate: applyTemplate,
  // githubApiRequest is intentionally not exported - it is an internal
  // implementation detail and exporting it broadens the attack surface
  // by allowing external callers to make authenticated API requests.
  escapeMarkdown: escapeMarkdown,
  isSafeUrl: isSafeUrl,
};
