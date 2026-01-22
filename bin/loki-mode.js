#!/usr/bin/env node
/**
 * Loki Mode CLI wrapper for npm distribution
 * Delegates to the bash CLI
 */

const { spawn } = require('child_process');
const path = require('path');

const lokiScript = path.join(__dirname, '..', 'autonomy', 'loki');
const args = process.argv.slice(2);

const child = spawn(lokiScript, args, {
  stdio: 'inherit',
  shell: true
});

child.on('close', (code) => {
  process.exit(code || 0);
});

child.on('error', (err) => {
  console.error('Error running loki:', err.message);
  console.error('Make sure bash is available on your system');
  process.exit(1);
});
