'use strict';

const fs = require('fs');
const path = require('path');

/**
 * loki/agent-metrics tool
 *
 * Returns Prometheus-compatible metrics for the current Loki Mode run.
 */

const TOOL_NAME = 'loki/agent-metrics';

const schema = {
  name: TOOL_NAME,
  description: 'Get Prometheus-compatible agent metrics including token usage, tool calls, RARV cycles, and timing.',
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['json', 'prometheus'],
        description: 'Output format (default: json)',
        default: 'json'
      }
    },
    required: []
  }
};

function execute(params) {
  const format = params.format || 'json';
  const lokiDir = path.resolve(process.cwd(), '.loki');
  const metricsDir = path.join(lokiDir, 'metrics');

  // Collect all metrics
  const metrics = {
    rarvCycles: 0,
    toolCalls: 0,
    toolBreakdown: {},
    tokensUsed: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    qualityGatesPassed: 0,
    qualityGatesFailed: 0,
    uptime: 0,
    timestamp: new Date().toISOString()
  };

  // Read orchestrator for cycle/task counts
  const orchPath = path.join(lokiDir, 'state', 'orchestrator.json');
  if (fs.existsSync(orchPath)) {
    try {
      const orch = JSON.parse(fs.readFileSync(orchPath, 'utf8'));
      metrics.rarvCycles = (orch.rarvCycle && orch.rarvCycle.count) || 0;
      metrics.tasksCompleted = orch.tasksCompleted || 0;
      metrics.tasksFailed = orch.tasksFailed || 0;
      if (orch.startedAt) {
        metrics.uptime = Math.floor((Date.now() - new Date(orch.startedAt).getTime()) / 1000);
      }
    } catch (err) {
      // Ignore
    }
  }

  // Read tool usage metrics
  const toolUsagePath = path.join(metricsDir, 'tool-usage.jsonl');
  if (fs.existsSync(toolUsagePath)) {
    try {
      const lines = fs.readFileSync(toolUsagePath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          metrics.toolCalls++;
          const toolName = entry.tool || 'unknown';
          metrics.toolBreakdown[toolName] = (metrics.toolBreakdown[toolName] || 0) + 1;
        } catch (err) {
          // Skip malformed lines
        }
      }
    } catch (err) {
      // Ignore
    }
  }

  // Read token economics
  const tokenPath = path.join(metricsDir, 'efficiency', 'token-usage.json');
  if (fs.existsSync(tokenPath)) {
    try {
      const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      metrics.tokensUsed = tokenData.totalTokens || tokenData.total || 0;
    } catch (err) {
      // Ignore
    }
  }

  // Read quality gate results
  const gatesPath = path.join(lokiDir, 'state', 'quality-gates.json');
  if (fs.existsSync(gatesPath)) {
    try {
      const gates = JSON.parse(fs.readFileSync(gatesPath, 'utf8'));
      const results = gates.results || gates.gates || [];
      for (const g of results) {
        if (g.passed || g.status === 'passed') metrics.qualityGatesPassed++;
        else metrics.qualityGatesFailed++;
      }
    } catch (err) {
      // Ignore
    }
  }

  if (format === 'prometheus') {
    return {
      success: true,
      contentType: 'text/plain',
      body: formatPrometheus(metrics)
    };
  }

  return {
    success: true,
    metrics: metrics
  };
}

function formatPrometheus(m) {
  const lines = [];
  lines.push('# HELP loki_rarv_cycles_total Total RARV cycles executed');
  lines.push('# TYPE loki_rarv_cycles_total counter');
  lines.push('loki_rarv_cycles_total ' + m.rarvCycles);
  lines.push('');
  lines.push('# HELP loki_tool_calls_total Total MCP tool calls');
  lines.push('# TYPE loki_tool_calls_total counter');
  lines.push('loki_tool_calls_total ' + m.toolCalls);
  lines.push('');
  lines.push('# HELP loki_tokens_used_total Total tokens consumed');
  lines.push('# TYPE loki_tokens_used_total counter');
  lines.push('loki_tokens_used_total ' + m.tokensUsed);
  lines.push('');
  lines.push('# HELP loki_tasks_completed_total Tasks completed successfully');
  lines.push('# TYPE loki_tasks_completed_total counter');
  lines.push('loki_tasks_completed_total ' + m.tasksCompleted);
  lines.push('');
  lines.push('# HELP loki_tasks_failed_total Tasks that failed');
  lines.push('# TYPE loki_tasks_failed_total counter');
  lines.push('loki_tasks_failed_total ' + m.tasksFailed);
  lines.push('');
  lines.push('# HELP loki_quality_gates_passed Quality gates passed');
  lines.push('# TYPE loki_quality_gates_passed counter');
  lines.push('loki_quality_gates_passed ' + m.qualityGatesPassed);
  lines.push('');
  lines.push('# HELP loki_quality_gates_failed Quality gates failed');
  lines.push('# TYPE loki_quality_gates_failed counter');
  lines.push('loki_quality_gates_failed ' + m.qualityGatesFailed);
  lines.push('');
  lines.push('# HELP loki_uptime_seconds Seconds since project start');
  lines.push('# TYPE loki_uptime_seconds gauge');
  lines.push('loki_uptime_seconds ' + m.uptime);
  lines.push('');
  return lines.join('\n');
}

// Result keys carrying stored text; the server moves them under untrusted_content.
const UNTRUSTED_FIELDS = ['metrics', 'body'];

module.exports = { TOOL_NAME, schema, execute, UNTRUSTED_FIELDS };
