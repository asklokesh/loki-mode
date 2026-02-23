'use strict';

var { LinearClient, LinearApiError, RateLimitError, LINEAR_API_URL } = require('./client');
var { LinearSync, PRIORITY_MAP, VALID_RARV_STATUSES } = require('./sync');
var { loadConfig, validateConfig, parseSimpleYaml, DEFAULT_STATUS_MAPPING } = require('./config');

/**
 * Create a configured Linear sync manager.
 * @param {object} config - Linear configuration object (apiKey, teamId, statusMapping, etc.)
 * @param {object} [options] - Optional adapter options
 * @returns {LinearSync}
 */
function createSync(config, options) {
  return new LinearSync(config, options);
}

module.exports = {
  LinearClient: LinearClient,
  LinearApiError: LinearApiError,
  RateLimitError: RateLimitError,
  LINEAR_API_URL: LINEAR_API_URL,
  LinearSync: LinearSync,
  PRIORITY_MAP: PRIORITY_MAP,
  VALID_RARV_STATUSES: VALID_RARV_STATUSES,
  DEFAULT_STATUS_MAPPING: DEFAULT_STATUS_MAPPING,
  loadConfig: loadConfig,
  validateConfig: validateConfig,
  parseSimpleYaml: parseSimpleYaml,
  createSync: createSync,
};
