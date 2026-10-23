'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * loki/checkpoint-restore tool
 *
 * List available checkpoints and restore project state from a specific checkpoint.
 */

const TOOL_NAME = 'loki/checkpoint-restore';

const schema = {
  name: TOOL_NAME,
  description: 'List available checkpoints or restore project state from a specific checkpoint.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'create', 'restore'],
        description: 'Action to perform (default: list)',
        default: 'list'
      },
      checkpointId: {
        type: 'string',
        description: 'Checkpoint ID (required for restore action)'
      },
      label: {
        type: 'string',
        description: 'Label for the checkpoint (used with create action)'
      }
    },
    required: []
  }
};

function execute(params) {
  const action = params.action || 'list';
  const lokiDir = path.resolve(process.cwd(), '.loki');
  const checkpointDir = path.join(lokiDir, 'checkpoints');

  if (action === 'list') {
    return listCheckpoints(checkpointDir);
  }

  if (action === 'create') {
    return createCheckpoint(lokiDir, checkpointDir, params.label);
  }

  if (action === 'restore') {
    if (!params.checkpointId) {
      return { success: false, error: 'checkpointId is required for restore action' };
    }
    return restoreCheckpoint(lokiDir, checkpointDir, params.checkpointId);
  }

  return { success: false, error: 'Unknown action: ' + action };
}

function listCheckpoints(checkpointDir) {
  if (!fs.existsSync(checkpointDir)) {
    return { success: true, checkpoints: [], count: 0 };
  }

  const entries = [];
  try {
    const files = fs.readdirSync(checkpointDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const fullPath = path.join(checkpointDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        entries.push({
          id: data.id || file.replace('.json', ''),
          label: data.label || '',
          createdAt: data.createdAt || null,
          phase: data.phase || 'unknown',
          tasksCompleted: data.tasksCompleted || 0
        });
      } catch (err) {
        // Skip corrupted checkpoints
      }
    }
  } catch (err) {
    return { success: false, error: 'Failed to read checkpoints: ' + err.message };
  }

  // Sort by creation time descending
  entries.sort((a, b) => {
    if (!a.createdAt) return 1;
    if (!b.createdAt) return -1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return { success: true, checkpoints: entries, count: entries.length };
}

function createCheckpoint(lokiDir, checkpointDir, label) {
  const stateDir = path.join(lokiDir, 'state');

  try {
    fs.mkdirSync(checkpointDir, { recursive: true });
  } catch (err) {
    return { success: false, error: 'Failed to create checkpoint directory: ' + err.message };
  }

  const checkpointId = 'chk-' + crypto.randomBytes(4).toString('hex');
  const timestamp = new Date().toISOString();

  // Snapshot all state files
  const snapshot = {
    id: checkpointId,
    label: label || '',
    createdAt: timestamp,
    state: {}
  };

  if (fs.existsSync(stateDir)) {
    try {
      const files = fs.readdirSync(stateDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = fs.readFileSync(path.join(stateDir, file), 'utf8');
          snapshot.state[file] = JSON.parse(content);
        } catch (err) {
          // Skip files that cannot be read
        }
      }
    } catch (err) {
      // Ignore
    }
  }

  // Extract summary fields
  const orch = snapshot.state['orchestrator.json'];
  if (orch) {
    snapshot.phase = orch.currentPhase || 'unknown';
    snapshot.tasksCompleted = orch.tasksCompleted || 0;
  }

  try {
    fs.writeFileSync(
      path.join(checkpointDir, checkpointId + '.json'),
      JSON.stringify(snapshot, null, 2),
      'utf8'
    );
  } catch (err) {
    return { success: false, error: 'Failed to write checkpoint: ' + err.message };
  }

  return {
    success: true,
    checkpointId: checkpointId,
    label: label || '',
    createdAt: timestamp,
    stateFiles: Object.keys(snapshot.state).length
  };
}

// Validate checkpoint ID format: only allow 'chk-' followed by 8 hex chars.
const CHECKPOINT_ID_RE = /^chk-[0-9a-f]{8}$/;

function restoreCheckpoint(lokiDir, checkpointDir, checkpointId) {
  // Validate format before any filesystem access to prevent path traversal.
  if (!CHECKPOINT_ID_RE.test(checkpointId)) {
    return { success: false, error: 'Invalid checkpoint ID format' };
  }

  const checkpointPath = path.resolve(checkpointDir, checkpointId + '.json');

  // Verify the resolved path is still inside checkpointDir.
  const resolvedDir = path.resolve(checkpointDir);
  if (!checkpointPath.startsWith(resolvedDir + path.sep) && checkpointPath !== resolvedDir) {
    return { success: false, error: 'Invalid checkpoint ID: path traversal detected' };
  }

  if (!fs.existsSync(checkpointPath)) {
    return { success: false, error: 'Checkpoint not found: ' + checkpointId };
  }

  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  } catch (err) {
    return { success: false, error: 'Failed to read checkpoint: ' + err.message };
  }

  const stateDir = path.join(lokiDir, 'state');
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch (err) {
    // Ignore if exists
  }

  // Restore each state file
  const restored = [];
  const stateEntries = snapshot.state || {};
  for (const [filename, content] of Object.entries(stateEntries)) {
    try {
      fs.writeFileSync(
        path.join(stateDir, filename),
        JSON.stringify(content, null, 2),
        'utf8'
      );
      restored.push(filename);
    } catch (err) {
      // Skip files that cannot be written
    }
  }

  return {
    success: true,
    checkpointId: checkpointId,
    label: snapshot.label || '',
    restoredAt: new Date().toISOString(),
    restoredFiles: restored,
    restoredCount: restored.length
  };
}

// Result keys carrying stored text; the server moves them under untrusted_content.
const UNTRUSTED_FIELDS = ['checkpoints', 'label', 'restoredFiles'];

module.exports = { TOOL_NAME, schema, execute, UNTRUSTED_FIELDS };
