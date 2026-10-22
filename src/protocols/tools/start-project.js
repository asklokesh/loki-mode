'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * loki/start-project tool
 *
 * Accepts PRD content or file path, initializes a Loki Mode project,
 * and returns a project ID with initial status.
 */

const TOOL_NAME = 'loki/start-project';

const schema = {
  name: TOOL_NAME,
  description: 'Start a new Loki Mode project from a PRD. Accepts PRD content directly or a file path.',
  inputSchema: {
    type: 'object',
    properties: {
      prd: {
        type: 'string',
        description: 'PRD content (inline text) or absolute file path to a PRD file'
      },
      provider: {
        type: 'string',
        enum: ['claude', 'codex', 'cline', 'aider'],
        description: 'AI provider to use (default: claude)',
        default: 'claude'
      }
    },
    required: ['prd']
  }
};

function execute(params) {
  const prd = params.prd || '';
  const provider = params.provider || 'claude';

  // Determine if prd is a file path or inline content
  let prdContent = prd;
  let prdSource = 'inline';

  if (prd.length < 500 && !prd.includes('\n')) {
    // Might be a file path
    const resolved = path.resolve(prd);
    if (fs.existsSync(resolved)) {
      try {
        prdContent = fs.readFileSync(resolved, 'utf8');
        prdSource = resolved;
      } catch (err) {
        return {
          success: false,
          error: 'Failed to read PRD file: ' + err.message
        };
      }
    }
  }

  if (!prdContent || prdContent.trim().length === 0) {
    return {
      success: false,
      error: 'PRD content is empty'
    };
  }

  // Session guard: check for active run
  const lokiDir = path.resolve(process.cwd(), '.loki');
  const stateDir = path.join(lokiDir, 'state');
  const sessionPath = path.join(stateDir, 'session.json');
  if (fs.existsSync(sessionPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      if (existing.status === 'running') {
        return {
          success: false,
          error: 'A project is already running',
          activeProject: existing.projectId,
          startedAt: existing.startedAt,
          hint: 'Use loki/project-status to check progress, or stop the current run first'
        };
      }
    } catch (e) { /* corrupted session file, safe to overwrite */ }
  }

  // Generate project ID
  const projectId = 'proj-' + crypto.randomBytes(4).toString('hex');
  const timestamp = new Date().toISOString();

  // Initialize .loki directory structure (lokiDir, stateDir declared above for session guard)
  const queueDir = path.join(lokiDir, 'queue');

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(queueDir, { recursive: true });
  } catch (err) {
    return {
      success: false,
      error: 'Failed to create .loki directories: ' + err.message
    };
  }

  // Write session state
  const session = {
    projectId: projectId,
    provider: provider,
    startedAt: timestamp,
    status: 'running',
    prdSource: prdSource,
    prdLength: prdContent.length,
    phase: 'discovery'
  };

  try {
    fs.writeFileSync(
      path.join(stateDir, 'session.json'),
      JSON.stringify(session, null, 2),
      'utf8'
    );
  } catch (err) {
    return {
      success: false,
      error: 'Failed to write session state: ' + err.message
    };
  }

  // Write orchestrator state
  const orchestrator = {
    projectId: projectId,
    currentPhase: 'discovery',
    tasksCompleted: 0,
    tasksFailed: 0,
    totalTasks: 0,
    startedAt: timestamp,
    rarvCycle: { count: 0, lastCycle: null }
  };

  try {
    fs.writeFileSync(
      path.join(stateDir, 'orchestrator.json'),
      JSON.stringify(orchestrator, null, 2),
      'utf8'
    );
  } catch (err) {
    return {
      success: false,
      error: 'Failed to write orchestrator state: ' + err.message
    };
  }

  return {
    success: true,
    projectId: projectId,
    provider: provider,
    phase: 'discovery',
    status: 'running',
    startedAt: timestamp,
    prdSource: prdSource,
    prdLength: prdContent.length,
    message: 'Project initialized. RARV cycle ready.'
  };
}

// Result keys carrying stored text; the server moves them under untrusted_content.
const UNTRUSTED_FIELDS = ['activeProject', 'startedAt'];

module.exports = { TOOL_NAME, schema, execute, UNTRUSTED_FIELDS };
