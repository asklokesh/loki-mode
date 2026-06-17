'use strict';

/**
 * Loki Mode Policy Engine - Core Evaluation Engine
 *
 * Loads policies from .loki/policies.json (primary) or .loki/policies.yaml (fallback).
 * Evaluates policies synchronously at enforcement points:
 *   - pre_execution: before agent actions
 *   - pre_deployment: before deployment
 *   - resource: token/provider constraints
 *   - data: secret/PII scanning
 *
 * Performance target: < 10ms per evaluation (synchronous, no I/O during eval).
 * File I/O only on init and reload (watched via fs.watchFile).
 *
 * When no policy file exists: all evaluations return ALLOW with zero overhead.
 */

const fs = require('fs');
const path = require('path');
const { Decision, evaluateRule, scanContent, validatePreExecution,
  validatePreDeployment, validateResource, validateData,
  validateApprovalGate, RULE_EVALUATORS } = require('./types');

// -------------------------------------------------------------------
// Minimal YAML parser for policy files
// -------------------------------------------------------------------

/**
 * Parse a subset of YAML sufficient for the policy format.
 * Handles: scalars, arrays (both inline and - item), nested objects via indentation.
 * Does NOT handle: multi-line strings, anchors/aliases, complex types.
 */
function parseSimpleYaml(text) {
  if (!text || typeof text !== 'string') return null;
  const lines = text.split('\n');
  return _parseBlock(lines, 0, 0).value;
}

function _parseBlock(lines, startIdx, baseIndent) {
  const result = {};
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    const indent = line.length - trimmed.length;
    if (indent < baseIndent) break; // dedent - return to parent
    if (indent > baseIndent && i > startIdx) break; // deeper than expected

    // key: value
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = trimmed.substring(0, colonIdx).trim();
    const rawValue = trimmed.substring(colonIdx + 1).trim();

    if (rawValue === '' || rawValue === '|' || rawValue === '>') {
      // Could be nested object or array
      // Peek at next non-empty line to determine
      let nextIdx = i + 1;
      while (nextIdx < lines.length && lines[nextIdx].trim() === '') nextIdx++;

      if (nextIdx < lines.length) {
        const nextTrimmed = lines[nextIdx].trimStart();
        const nextIndent = lines[nextIdx].length - nextTrimmed.length;

        if (nextIndent > indent && nextTrimmed.startsWith('- ')) {
          // Array of items
          const arr = _parseArray(lines, nextIdx, nextIndent);
          result[key] = arr.value;
          i = arr.endIdx;
          continue;
        } else if (nextIndent > indent) {
          // Nested object
          const nested = _parseBlock(lines, nextIdx, nextIndent);
          result[key] = nested.value;
          i = nested.endIdx;
          continue;
        }
      }
      result[key] = rawValue || null;
      i++;
    } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      // Inline array: [a, b, c]
      const inner = rawValue.substring(1, rawValue.length - 1);
      result[key] = inner.split(',').map(function (s) {
        const v = s.trim();
        // Strip quotes
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          return v.substring(1, v.length - 1);
        }
        // Number?
        const n = Number(v);
        if (!isNaN(n) && v !== '') return n;
        return v;
      });
      i++;
    } else {
      // Scalar value
      result[key] = _parseScalar(rawValue);
      i++;
    }
  }

  return { value: result, endIdx: i };
}

function _parseArray(lines, startIdx, baseIndent) {
  const result = [];
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (!trimmed || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    const indent = line.length - trimmed.length;
    if (indent < baseIndent) break;

    if (!trimmed.startsWith('- ')) {
      break;
    }

    const itemContent = trimmed.substring(2).trim();
    const colonIdx = itemContent.indexOf(':');

    if (colonIdx === -1) {
      // Simple scalar array item
      result.push(_parseScalar(itemContent));
      i++;
    } else {
      // Object array item -- first key:value is on the "- " line
      const firstKey = itemContent.substring(0, colonIdx).trim();
      const firstVal = itemContent.substring(colonIdx + 1).trim();
      const obj = {};
      if (firstVal.startsWith('[') && firstVal.endsWith(']')) {
        const inner = firstVal.substring(1, firstVal.length - 1);
        obj[firstKey] = inner.split(',').map(function (s) {
          const v = s.trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            return v.substring(1, v.length - 1);
          }
          const n = Number(v);
          if (!isNaN(n) && v !== '') return n;
          return v;
        });
      } else {
        obj[firstKey] = _parseScalar(firstVal);
      }
      i++;

      // Continuation lines for this object item (indented beyond the "- ")
      const itemIndent = indent + 2;
      while (i < lines.length) {
        const subLine = lines[i];
        const subTrimmed = subLine.trimStart();
        if (!subTrimmed || subTrimmed.startsWith('#')) {
          i++;
          continue;
        }
        const subIndent = subLine.length - subTrimmed.length;
        if (subIndent < itemIndent) break;

        const subColonIdx = subTrimmed.indexOf(':');
        if (subColonIdx === -1) {
          i++;
          continue;
        }
        const subKey = subTrimmed.substring(0, subColonIdx).trim();
        const subVal = subTrimmed.substring(subColonIdx + 1).trim();
        if (subVal.startsWith('[') && subVal.endsWith(']')) {
          const inner2 = subVal.substring(1, subVal.length - 1);
          obj[subKey] = inner2.split(',').map(function (s) {
            const v = s.trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
              return v.substring(1, v.length - 1);
            }
            const n = Number(v);
            if (!isNaN(n) && v !== '') return n;
            return v;
          });
        } else {
          obj[subKey] = _parseScalar(subVal);
        }
        i++;
      }
      result.push(obj);
    }
  }

  return { value: result, endIdx: i };
}

function _parseScalar(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  // Strip quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.substring(1, v.length - 1);
  }
  const n = Number(v);
  if (!isNaN(n) && v !== '') return n;
  return v;
}

// -------------------------------------------------------------------
// Policy Engine class
// -------------------------------------------------------------------

class PolicyEngine {
  /**
   * @param {string} projectDir - Root directory of the project (contains .loki/)
   * @param {object} [options]
   * @param {boolean} [options.watch=false] - Watch policy file for changes
   */
  constructor(projectDir, options) {
    this._projectDir = projectDir || process.cwd();
    this._options = options || {};
    this._policies = null;       // parsed policy object (cached)
    this._policyPath = null;     // resolved path to policy file
    this._loaded = false;
    this._watcher = null;
    this._validationErrors = [];

    this._init();
  }

  // -----------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------

  _init() {
    const lokiDir = path.join(this._projectDir, '.loki');
    const jsonPath = path.join(lokiDir, 'policies.json');
    const yamlPath = path.join(lokiDir, 'policies.yaml');

    // Try JSON first, then YAML
    if (fs.existsSync(jsonPath)) {
      this._policyPath = jsonPath;
    } else if (fs.existsSync(yamlPath)) {
      this._policyPath = yamlPath;
    } else {
      // No policy file -- zero overhead mode
      this._policies = null;
      this._loaded = true;
      return;
    }

    this._loadPolicies();

    if (this._options.watch) {
      this._startWatcher();
    }
  }

  _loadPolicies() {
    if (!this._policyPath) return;

    try {
      const content = fs.readFileSync(this._policyPath, 'utf8');
      let parsed;

      if (this._policyPath.endsWith('.json')) {
        parsed = JSON.parse(content);
      } else {
        parsed = parseSimpleYaml(content);
      }

      this._validationErrors = this._validatePolicies(parsed);
      if (this._validationErrors.length > 0) {
        // Still load, but track errors
      }

      this._policies = parsed;
      this._loaded = true;
    } catch (err) {
      this._validationErrors = ['Failed to load policy file: ' + err.message];
      this._policies = null;
      this._loaded = true;
    }
  }

  _validatePolicies(parsed) {
    const errors = [];
    if (!parsed || typeof parsed !== 'object') {
      errors.push('Policy file must be a YAML/JSON object');
      return errors;
    }

    const policies = parsed.policies || parsed;

    if (policies.pre_execution && Array.isArray(policies.pre_execution)) {
      const knownRuleKeys = Object.keys(RULE_EVALUATORS);
      policies.pre_execution.forEach(function (entry, i) {
        const result = validatePreExecution(entry);
        if (!result.valid) {
          errors.push('pre_execution[' + i + ']: ' + result.errors.join(', '));
        }
        // Warn when rule string doesn't match any known evaluator (likely typo).
        // This is a warning (not a hard error) to preserve forward-compatibility
        // for future custom rule strings.
        if (entry && typeof entry.rule === 'string') {
          const recognized = knownRuleKeys.some(function (k) {
            return entry.rule === k || entry.rule.startsWith(k);
          });
          if (!recognized) {
            errors.push('pre_execution[' + i + ']: warning: rule "' + entry.rule + '" is not recognized by any built-in evaluator and will always pass');
          }
        }
      });
    }
    if (policies.pre_deployment && Array.isArray(policies.pre_deployment)) {
      policies.pre_deployment.forEach(function (entry, i) {
        const result = validatePreDeployment(entry);
        if (!result.valid) {
          errors.push('pre_deployment[' + i + ']: ' + result.errors.join(', '));
        }
      });
    }
    if (policies.resource && Array.isArray(policies.resource)) {
      policies.resource.forEach(function (entry, i) {
        const result = validateResource(entry);
        if (!result.valid) {
          errors.push('resource[' + i + ']: ' + result.errors.join(', '));
        }
      });
    }
    if (policies.data && Array.isArray(policies.data)) {
      policies.data.forEach(function (entry, i) {
        const result = validateData(entry);
        if (!result.valid) {
          errors.push('data[' + i + ']: ' + result.errors.join(', '));
        }
      });
    }
    if (policies.approval_gates && Array.isArray(policies.approval_gates)) {
      policies.approval_gates.forEach(function (entry, i) {
        const result = validateApprovalGate(entry);
        if (!result.valid) {
          errors.push('approval_gates[' + i + ']: ' + result.errors.join(', '));
        }
      });
    }

    return errors;
  }

  _startWatcher() {
    if (!this._policyPath || this._watcher) return;
    const self = this;
    // fs.watchFile uses polling, works on all platforms
    fs.watchFile(this._policyPath, { interval: 1000 }, function () {
      self._loadPolicies();
    });
    this._watcher = true;
  }

  // -----------------------------------------------------------------
  // Public: evaluate
  // -----------------------------------------------------------------

  /**
   * Evaluate policies for a given enforcement point.
   *
   * @param {string} enforcementPoint - One of: pre_execution, pre_deployment, resource, data
   * @param {object} context - Contextual data for evaluation
   * @returns {{ allowed: boolean, decision: string, reason: string, requiresApproval: boolean, violations: Array }}
   */
  evaluate(enforcementPoint, context) {
    // No policies loaded: instant ALLOW
    if (!this._policies) {
      return {
        allowed: true,
        decision: Decision.ALLOW,
        reason: 'No policies configured',
        requiresApproval: false,
        violations: [],
      };
    }

    const policies = this._policies.policies || this._policies;
    const entries = policies[enforcementPoint];

    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return {
        allowed: true,
        decision: Decision.ALLOW,
        reason: 'No policies defined for ' + enforcementPoint,
        requiresApproval: false,
        violations: [],
      };
    }

    const ctx = context || {};
    const violations = [];
    let requiresApproval = false;

    switch (enforcementPoint) {
      case 'pre_execution':
        this._evaluatePreExecution(entries, ctx, violations);
        break;
      case 'pre_deployment':
        this._evaluatePreDeployment(entries, ctx, violations);
        break;
      case 'resource':
        this._evaluateResource(entries, ctx, violations);
        break;
      case 'data':
        this._evaluateData(entries, ctx, violations);
        break;
      default:
        return {
          allowed: true,
          decision: Decision.ALLOW,
          reason: 'Unknown enforcement point: ' + enforcementPoint,
          requiresApproval: false,
          violations: [],
        };
    }

    // Check for approval requirements
    for (let i = 0; i < violations.length; i++) {
      if (violations[i].action === 'require_approval') {
        requiresApproval = true;
      }
    }

    const denied = violations.some(function (v) { return v.action === 'deny'; });

    if (denied) {
      return {
        allowed: false,
        decision: Decision.DENY,
        reason: violations.map(function (v) { return v.name + ': ' + v.reason; }).join('; '),
        requiresApproval: false,
        violations: violations,
      };
    }

    if (requiresApproval) {
      return {
        allowed: false,
        decision: Decision.REQUIRE_APPROVAL,
        reason: violations.map(function (v) { return v.name + ': ' + v.reason; }).join('; '),
        requiresApproval: true,
        violations: violations,
      };
    }

    return {
      allowed: true,
      decision: Decision.ALLOW,
      reason: 'All policies passed',
      requiresApproval: false,
      violations: [],
    };
  }

  // -----------------------------------------------------------------
  // Enforcement evaluators (all synchronous)
  // -----------------------------------------------------------------

  _evaluatePreExecution(entries, context, violations) {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const result = evaluateRule(entry.rule, context);
      // result: true = pass, false = fail, null = unknown rule (pass)
      if (result === false) {
        violations.push({
          name: entry.name,
          action: entry.action || 'deny',
          reason: 'Rule violated: ' + entry.rule,
        });
      }
    }
  }

  _evaluatePreDeployment(entries, context, violations) {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry.gates || !Array.isArray(entry.gates)) continue;

      const passedGates = context.passed_gates || [];
      for (let g = 0; g < entry.gates.length; g++) {
        if (passedGates.indexOf(entry.gates[g]) === -1) {
          violations.push({
            name: entry.name,
            action: entry.action || 'deny',
            reason: 'Required gate not passed: ' + entry.gates[g],
          });
        }
      }
    }
  }

  _evaluateResource(entries, context, violations) {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];

      // Provider restriction check
      if (entry.providers && Array.isArray(entry.providers)) {
        if (context.provider && entry.providers.indexOf(context.provider) === -1) {
          violations.push({
            name: entry.name,
            action: entry.action || 'deny',
            reason: 'Provider "' + context.provider + '" not in approved list: ' + entry.providers.join(', '),
          });
        }
      }

      // Token budget check
      if (entry.max_tokens && context.tokens_consumed !== undefined) {
        if (context.tokens_consumed >= entry.max_tokens) {
          violations.push({
            name: entry.name,
            action: entry.on_exceed === 'require_approval' ? 'require_approval' : 'deny',
            reason: 'Token budget exceeded: ' + context.tokens_consumed + ' >= ' + entry.max_tokens,
          });
        }
      }
    }
  }

  _evaluateData(entries, context, violations) {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!context.content) continue;

      const findings = scanContent(context.content, entry.type);
      if (findings.length > 0) {
        violations.push({
          name: entry.name,
          action: entry.action || 'deny',
          reason: entry.type + ' detected: ' + findings.length + ' finding(s)',
          findings: findings,
        });
      }
    }
  }

  // -----------------------------------------------------------------
  // Public: accessors
  // -----------------------------------------------------------------

  /**
   * Get the list of approval gate definitions from the loaded policies.
   */
  getApprovalGates() {
    if (!this._policies) return [];
    const policies = this._policies.policies || this._policies;
    return policies.approval_gates || [];
  }

  /**
   * Get resource policies (for cost control integration).
   */
  getResourcePolicies() {
    if (!this._policies) return [];
    const policies = this._policies.policies || this._policies;
    return policies.resource || [];
  }

  /**
   * Whether any policies are loaded.
   */
  hasPolicies() {
    return this._policies !== null;
  }

  /**
   * Get validation errors from last load.
   */
  getValidationErrors() {
    return this._validationErrors;
  }

  /**
   * Whether a policy file is present on disk but could not be parsed/loaded
   * into a usable policy object.
   *
   * This is the fail-closed discriminator: it is true only when a policy file
   * exists (_policyPath set) yet parsing failed (_policies === null). It is
   * deliberately NOT keyed off getValidationErrors() length, because a valid
   * policy file can still carry soft warnings (e.g. an unrecognized rule
   * string) while parsing cleanly into a non-null _policies object. Those
   * warnings must not disable enforcement.
   *
   * When no policy file exists at all, _policyPath is null and this returns
   * false, preserving the legitimate "no policies -> allow" behavior.
   *
   * @returns {boolean}
   */
  hasLoadErrors() {
    return this._policyPath !== null && this._policies === null;
  }

  /**
   * Stop watching the policy file.
   */
  destroy() {
    if (this._watcher && this._policyPath) {
      fs.unwatchFile(this._policyPath);
      this._watcher = null;
    }
  }

  /**
   * Force reload policies from disk.
   */
  reload() {
    this._loadPolicies();
  }
}

// -------------------------------------------------------------------
// Exports
// -------------------------------------------------------------------

module.exports = { PolicyEngine, parseSimpleYaml };
