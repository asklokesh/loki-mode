'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Continuity resource provider
 *
 * Exposes CONTINUITY.md as an MCP resource at loki://state/continuity
 */

const RESOURCE_URI = 'loki://state/continuity';

const { UNTRUSTED_NOTICE } = require('../untrusted');

const schema = {
  uri: RESOURCE_URI,
  name: 'Continuity Document',
  description: 'The CONTINUITY.md file containing session state, decisions, and context for continuation.',
  mimeType: 'application/json'
};

function read() {
  const lokiDir = path.resolve(process.cwd(), '.loki');
  const continuityPath = path.join(lokiDir, 'CONTINUITY.md');

  if (!fs.existsSync(continuityPath)) {
    return {
      uri: RESOURCE_URI,
      mimeType: 'application/json',
      text: JSON.stringify({ error: 'No CONTINUITY.md found. No active session continuity document exists.' })
    };
  }

  try {
    const content = fs.readFileSync(continuityPath, 'utf8');
    // Same envelope as the Python server (mcp/server.py _UNTRUSTED_RESOURCES): stored text is data, never instructions.
    return {
      uri: RESOURCE_URI,
      mimeType: 'application/json',
      text: JSON.stringify({
        untrusted: true,
        notice: UNTRUSTED_NOTICE,
        untrusted_content: { content: content }
      })
    };
  } catch (err) {
    return {
      uri: RESOURCE_URI,
      mimeType: 'application/json',
      text: JSON.stringify({ error: 'Error reading CONTINUITY.md: ' + err.message })
    };
  }
}

module.exports = { RESOURCE_URI, schema, read };
