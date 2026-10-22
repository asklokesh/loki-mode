'use strict';

const fs = require('fs');
const path = require('path');
const { UNTRUSTED_NOTICE } = require('../untrusted');

/**
 * Memory resource provider
 *
 * Exposes cross-project learning data as MCP resources.
 * Provides the memory index (Layer 1) and semantic patterns.
 */

const RESOURCE_URI = 'loki://memory/learning';

const schema = {
  uri: RESOURCE_URI,
  name: 'Cross-Project Learning Data',
  description: 'Aggregated learning data from previous projects including semantic patterns, error patterns, and tool efficiency data.',
  mimeType: 'application/json'
};

function read() {
  const lokiDir = path.resolve(process.cwd(), '.loki');
  const memoryDir = path.join(lokiDir, 'memory');
  const learningDir = path.join(lokiDir, 'learning');

  const result = {
    uri: RESOURCE_URI,
    mimeType: 'application/json',
    text: ''
  };

  const data = {
    semanticPatterns: [],
    errorPatterns: [],
    toolEfficiency: [],
    index: null
  };

  // Read memory index
  const indexPath = path.join(memoryDir, 'index.json');
  if (fs.existsSync(indexPath)) {
    try {
      data.index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (err) {
      // Ignore
    }
  }

  // Read semantic patterns
  const semanticDir = path.join(memoryDir, 'semantic');
  if (fs.existsSync(semanticDir)) {
    try {
      const files = fs.readdirSync(semanticDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const pattern = JSON.parse(
            fs.readFileSync(path.join(semanticDir, file), 'utf8')
          );
          data.semanticPatterns.push({
            id: pattern.id || file.replace('.json', ''),
            pattern: pattern.pattern || '',
            category: pattern.category || '',
            confidence: pattern.confidence || 0,
            usageCount: pattern.usage_count || pattern.usageCount || 0
          });
        } catch (err) {
          // Skip corrupted files
        }
      }
    } catch (err) {
      // Ignore
    }
  }

  // Read cross-project learning aggregates
  const aggregatePath = path.join(learningDir, 'aggregate.json');
  if (fs.existsSync(aggregatePath)) {
    try {
      const aggregate = JSON.parse(fs.readFileSync(aggregatePath, 'utf8'));
      if (aggregate.errorPatterns) {
        data.errorPatterns = aggregate.errorPatterns;
      }
      if (aggregate.toolEfficiency) {
        data.toolEfficiency = aggregate.toolEfficiency;
      }
    } catch (err) {
      // Ignore
    }
  }

  // Read individual learning signal files
  const signalsDir = path.join(learningDir, 'signals');
  if (fs.existsSync(signalsDir)) {
    try {
      const files = fs.readdirSync(signalsDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        try {
          const lines = fs.readFileSync(path.join(signalsDir, file), 'utf8').split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const signal = JSON.parse(line);
              if (signal.type === 'error_pattern') {
                data.errorPatterns.push(signal);
              } else if (signal.type === 'tool_efficiency') {
                data.toolEfficiency.push(signal);
              }
            } catch (err) {
              // Skip malformed lines
            }
          }
        } catch (err) {
          // Skip unreadable files
        }
      }
    } catch (err) {
      // Ignore
    }
  }

  result.text = JSON.stringify({ untrusted: true, notice: UNTRUSTED_NOTICE, untrusted_content: data }, null, 2);
  return result;
}

module.exports = { RESOURCE_URI, schema, read };
