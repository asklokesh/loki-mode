'use strict';

const fs = require('fs');
const path = require('path');

/**
 * loki/project-status tool
 *
 * Returns the current RARV cycle state, active agents, and quality gate results.
 */

const TOOL_NAME = 'loki/project-status';

const schema = {
  name: TOOL_NAME,
  description: 'Get the current project status including RARV cycle state, active agents, and quality gate results.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'Project ID (optional, uses current session if not specified)'
      }
    },
    required: []
  }
};

function execute(params) {
  const lokiDir = path.resolve(process.cwd(), '.loki');
  const stateDir = path.join(lokiDir, 'state');

  // Read orchestrator state
  let orchestrator = null;
  const orchPath = path.join(stateDir, 'orchestrator.json');
  if (fs.existsSync(orchPath)) {
    try {
      orchestrator = JSON.parse(fs.readFileSync(orchPath, 'utf8'));
    } catch (err) {
      // Corrupted state file
    }
  }

  // Read session state
  let session = null;
  const sessionPath = path.join(stateDir, 'session.json');
  if (fs.existsSync(sessionPath)) {
    try {
      session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    } catch (err) {
      // Corrupted state file
    }
  }

  if (!orchestrator && !session) {
    return {
      success: false,
      error: 'No active project found. Use loki/start-project to begin.'
    };
  }

  // Read task queue for summary
  let taskSummary = { total: 0, pending: 0, inProgress: 0, completed: 0, blocked: 0 };
  const queuePath = path.join(stateDir, 'task-queue.json');
  if (fs.existsSync(queuePath)) {
    try {
      const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      const tasks = queue.tasks || [];
      taskSummary.total = tasks.length;
      for (const t of tasks) {
        const s = (t.status || '').toLowerCase().replace(/_/g, '');
        if (s === 'pending') taskSummary.pending++;
        else if (s === 'inprogress') taskSummary.inProgress++;
        else if (s === 'completed' || s === 'done') taskSummary.completed++;
        else if (s === 'blocked') taskSummary.blocked++;
      }
    } catch (err) {
      // Ignore
    }
  }

  // Read quality gate results if present
  let qualityGates = null;
  const gatesPath = path.join(stateDir, 'quality-gates.json');
  if (fs.existsSync(gatesPath)) {
    try {
      qualityGates = JSON.parse(fs.readFileSync(gatesPath, 'utf8'));
    } catch (err) {
      // Ignore
    }
  }

  // Check for PAUSE/STOP signals
  const paused = fs.existsSync(path.join(lokiDir, 'PAUSE'));
  const stopped = fs.existsSync(path.join(lokiDir, 'STOP'));

  return {
    success: true,
    projectId: (orchestrator && orchestrator.projectId) || (session && session.projectId) || 'unknown',
    phase: (orchestrator && orchestrator.currentPhase) || 'unknown',
    status: stopped ? 'stopped' : paused ? 'paused' : (session && session.status) || 'unknown',
    provider: (session && session.provider) || 'unknown',
    rarvCycle: (orchestrator && orchestrator.rarvCycle) || { count: 0, lastCycle: null },
    tasks: taskSummary,
    qualityGates: qualityGates,
    startedAt: (orchestrator && orchestrator.startedAt) || (session && session.startedAt) || null
  };
}

// Result keys carrying stored text; the server moves them under untrusted_content.
const UNTRUSTED_FIELDS = ['projectId', 'phase', 'status', 'provider', 'rarvCycle', 'qualityGates', 'startedAt'];

module.exports = { TOOL_NAME, schema, execute, UNTRUSTED_FIELDS };
