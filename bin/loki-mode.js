#!/usr/bin/env node
/**
 * Loki Mode npm wrapper.
 *
 * Delegates to bin/loki (the runtime-aware shim) so that ported commands
 * route through the Bun runtime when bun is on PATH and unported commands
 * fall through to autonomy/loki (bash). Pre-v7.4.7 this script bypassed
 * the shim and went straight to bash, which silently disabled the Bun
 * route for users invoking the `loki-mode` binary instead of `loki`.
 */

const { spawn } = require('child_process');
const path = require('path');

const shim = path.join(__dirname, 'loki');
const args = process.argv.slice(2);

const child = spawn(shim, args, {
  stdio: 'inherit',
});

child.on('close', (code) => {
  process.exit(code || 0);
});

child.on('error', (err) => {
  console.error('Error running loki:', err.message);
  console.error('Make sure bash is available on your system (bin/loki shim requires /bin/bash).');
  process.exit(1);
});
