'use strict';

const path = require('path');

/**
 * Loki Mode Policy Engine - Type Definitions and Validators
 *
 * Defines the schema for each policy type:
 *   - pre_execution: file access restrictions, agent concurrency limits
 *   - pre_deployment: quality gate requirements
 *   - resource: token budgets, provider restrictions
 *   - data: secret detection, PII scanning
 *   - approval_gates: approval breakpoints with webhook/timeout
 *
 * All validators are synchronous and allocation-light for fast evaluation.
 */

// -------------------------------------------------------------------
// Policy decision constants
// -------------------------------------------------------------------

const Decision = {
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  REQUIRE_APPROVAL: 'REQUIRE_APPROVAL',
};

// -------------------------------------------------------------------
// Schema validators
// -------------------------------------------------------------------

/**
 * Validate a pre_execution policy entry.
 * Required fields: name, rule, action
 */
function validatePreExecution(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['Entry must be an object'] };
  }
  if (typeof entry.name !== 'string' || entry.name.length === 0) {
    errors.push('name is required and must be a non-empty string');
  }
  if (typeof entry.rule !== 'string' || entry.rule.length === 0) {
    errors.push('rule is required and must be a non-empty string');
  }
  const validActions = ['deny', 'allow', 'require_approval'];
  if (!validActions.includes(entry.action)) {
    errors.push('action must be one of: ' + validActions.join(', '));
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a pre_deployment policy entry.
 * Required fields: name, gates (array of gate names)
 */
function validatePreDeployment(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['Entry must be an object'] };
  }
  if (typeof entry.name !== 'string' || entry.name.length === 0) {
    errors.push('name is required and must be a non-empty string');
  }
  if (!Array.isArray(entry.gates) || entry.gates.length === 0) {
    errors.push('gates must be a non-empty array of gate names');
  }
  const validActions = ['deny', 'allow', 'require_approval'];
  if (entry.action && !validActions.includes(entry.action)) {
    errors.push('action must be one of: ' + validActions.join(', '));
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a resource policy entry.
 * Required fields: name
 * Optional: max_tokens, alerts, on_exceed, providers, action
 */
function validateResource(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['Entry must be an object'] };
  }
  if (typeof entry.name !== 'string' || entry.name.length === 0) {
    errors.push('name is required and must be a non-empty string');
  }
  if (entry.max_tokens !== undefined) {
    if (typeof entry.max_tokens !== 'number' || entry.max_tokens <= 0) {
      errors.push('max_tokens must be a positive number');
    }
  }
  if (entry.alerts !== undefined) {
    if (!Array.isArray(entry.alerts)) {
      errors.push('alerts must be an array of numbers');
    } else {
      for (let i = 0; i < entry.alerts.length; i++) {
        const v = entry.alerts[i];
        if (typeof v !== 'number' || v < 0 || v > 100) {
          errors.push('alerts[' + i + '] must be a number between 0 and 100');
        }
      }
    }
  }
  const validExceed = ['shutdown', 'warn', 'require_approval'];
  if (entry.on_exceed && !validExceed.includes(entry.on_exceed)) {
    errors.push('on_exceed must be one of: ' + validExceed.join(', '));
  }
  if (entry.providers !== undefined) {
    if (!Array.isArray(entry.providers) || entry.providers.length === 0) {
      errors.push('providers must be a non-empty array of provider names');
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a data policy entry.
 * Required fields: name, type (secret_detection | pii_scanning)
 */
function validateData(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['Entry must be an object'] };
  }
  if (typeof entry.name !== 'string' || entry.name.length === 0) {
    errors.push('name is required and must be a non-empty string');
  }
  const validTypes = ['secret_detection', 'pii_scanning'];
  if (!validTypes.includes(entry.type)) {
    errors.push('type must be one of: ' + validTypes.join(', '));
  }
  if (entry.patterns !== undefined) {
    if (!Array.isArray(entry.patterns)) {
      errors.push('patterns must be an array of regex strings');
    }
  }
  const validActions = ['deny', 'warn', 'require_approval'];
  if (entry.action && !validActions.includes(entry.action)) {
    errors.push('action must be one of: ' + validActions.join(', '));
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate an approval_gates entry.
 * Required fields: name, phase
 */
function validateApprovalGate(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['Entry must be an object'] };
  }
  if (typeof entry.name !== 'string' || entry.name.length === 0) {
    errors.push('name is required and must be a non-empty string');
  }
  if (typeof entry.phase !== 'string' || entry.phase.length === 0) {
    errors.push('phase is required and must be a non-empty string');
  }
  if (entry.timeout_minutes !== undefined) {
    if (typeof entry.timeout_minutes !== 'number' || entry.timeout_minutes <= 0) {
      errors.push('timeout_minutes must be a positive number');
    }
  }
  if (entry.webhook !== undefined) {
    if (typeof entry.webhook !== 'string' || entry.webhook.length === 0) {
      errors.push('webhook must be a non-empty string URL');
    } else {
      try {
        const parsed = new URL(entry.webhook);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.push('webhook must use http or https protocol');
        }
      } catch (_) {
        errors.push('webhook must be a valid URL');
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

// -------------------------------------------------------------------
// Autonomy level (top-level `autonomy` plus optional `actions` overrides)
// -------------------------------------------------------------------

const AUTONOMY_LEVELS = ['propose', 'execute', 'operate'];
const AUTONOMY_ACTION_KEYS = ['pr', 'push', 'deploy'];
const AUTONOMY_ACTION_VALUES = ['allow', 'deny', 'require_approval'];

/**
 * What an autonomy level permits: propose = nothing, execute = open a PR,
 * operate = PR plus deploy. merge is never granted by a level.
 * An unknown level returns null (callers must fail closed).
 */
function allowedActions(level) {
  if (level === 'propose') return { pr: false, merge: false, deploy: false };
  if (level === 'execute') return { pr: true, merge: false, deploy: false };
  if (level === 'operate') return { pr: true, merge: false, deploy: true };
  return null;
}

/**
 * Validate the autonomy block of a policy document.
 * `autonomy` is propose|execute|operate; `actions` maps pr/push/deploy to
 * allow|deny|require_approval. Returns a list of error strings.
 */
function validateAutonomy(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return errors;
  if (doc.autonomy !== undefined && AUTONOMY_LEVELS.indexOf(doc.autonomy) === -1) {
    errors.push('autonomy must be one of: ' + AUTONOMY_LEVELS.join(', '));
  }
  if (doc.actions !== undefined) {
    if (!doc.actions || typeof doc.actions !== 'object' || Array.isArray(doc.actions)) {
      errors.push('actions must be an object keyed by: ' + AUTONOMY_ACTION_KEYS.join(', '));
    } else {
      Object.keys(doc.actions).forEach(function (k) {
        if (AUTONOMY_ACTION_KEYS.indexOf(k) === -1) {
          errors.push('actions.' + k + ': unknown action key (expected ' + AUTONOMY_ACTION_KEYS.join(', ') + ')');
        } else if (AUTONOMY_ACTION_VALUES.indexOf(doc.actions[k]) === -1) {
          errors.push('actions.' + k + ' must be one of: ' + AUTONOMY_ACTION_VALUES.join(', '));
        }
      });
    }
  }
  return errors;
}

// -------------------------------------------------------------------
// Built-in rule evaluators for pre_execution policies
// -------------------------------------------------------------------

/**
 * Built-in rule matchers. Each rule string is checked against these.
 * Returns null if the rule is not recognized (custom rules always pass).
 */
const RULE_EVALUATORS = {
  /**
   * "file_path must start with project_dir"
   * Context must contain: file_path (string), project_dir (string)
   *
   * Uses path.resolve() on both paths to normalize traversal sequences
   * (e.g., /project/../etc/passwd) and ensures prefix ends with path.sep
   * to prevent sibling-directory bypass (/project-evil matching /project).
   */
  'file_path must start with project_dir': function (context) {
    if (!context.file_path || !context.project_dir) return null;
    const fp = path.resolve(String(context.file_path));
    const pd = path.resolve(String(context.project_dir));
    const base = pd.endsWith(path.sep) ? pd : pd + path.sep;
    return fp === pd || fp.startsWith(base);
  },

  /**
   * "active_agents <= N"
   * Context must contain: active_agents (number)
   * The rule string is parsed for the number.
   */
  'active_agents': function (context, rule) {
    if (context.active_agents === undefined) return null;
    const match = rule.match(/active_agents\s*<=\s*(\d+)/);
    if (!match) return null;
    const limit = parseInt(match[1], 10);
    return context.active_agents <= limit;
  },
};

/**
 * Evaluate a rule string against a context object.
 * Returns true (pass), false (fail), or null (unrecognized rule -- treated as pass).
 */
function evaluateRule(rule, context) {
  if (!rule || !context) return null;

  // Check direct match first
  if (RULE_EVALUATORS[rule]) {
    return RULE_EVALUATORS[rule](context);
  }

  // Check partial match (e.g., "active_agents <= 10" matches "active_agents" evaluator)
  for (const key of Object.keys(RULE_EVALUATORS)) {
    if (rule.startsWith(key)) {
      return RULE_EVALUATORS[key](context, rule);
    }
  }

  // Unrecognized rule: default to pass (do not block on unknown rules)
  return null;
}

// -------------------------------------------------------------------
// Secret detection patterns (built-in)
// -------------------------------------------------------------------

const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i,
  /(?:secret|token|password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{8,}/i,
  /(?:aws_access_key_id|aws_secret_access_key)\s*[:=]\s*["']?[A-Za-z0-9/+=]{16,}/i,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{36}/,
  /sk-[A-Za-z0-9]{32,}/,
  /xoxb-[0-9]{10,}-[A-Za-z0-9]{20,}/,
];

// -------------------------------------------------------------------
// PII patterns (built-in)
// -------------------------------------------------------------------

const PII_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
  /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/,  // SSN
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,  // Phone
  /\b(?:\d{4}[- ]?){3}\d{4}\b/,     // Credit card
];

/**
 * Run data policy scanning against content.
 * Returns array of { pattern, match } for any detections.
 */
function scanContent(content, policyType) {
  if (!content || typeof content !== 'string') return [];
  const patterns = policyType === 'pii_scanning' ? PII_PATTERNS : SECRET_PATTERNS;
  const findings = [];
  for (let i = 0; i < patterns.length; i++) {
    const m = content.match(patterns[i]);
    if (m) {
      findings.push({ patternIndex: i, match: m[0].substring(0, 20) + '...' });
    }
  }
  return findings;
}

// -------------------------------------------------------------------
// Exports
// -------------------------------------------------------------------

module.exports = {
  Decision,
  validatePreExecution,
  validatePreDeployment,
  validateResource,
  validateData,
  validateApprovalGate,
  validateAutonomy,
  allowedActions,
  evaluateRule,
  scanContent,
  SECRET_PATTERNS,
  PII_PATTERNS,
  RULE_EVALUATORS,
};
