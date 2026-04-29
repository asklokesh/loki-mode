#!/usr/bin/env node
/**
 * Loki Mode npm wrapper.
 *
 * Delegates to bin/loki (the runtime-aware shim).
 *
 * v7.4.12: Removed from package.json `bin` map. Existing installs that have
 * `loki-mode` symlinked still work (file is on disk + delegates to `loki`),
 * but new installs only get the `loki` binary. Prints a one-time deprecation
 * banner to stderr so muscle-memory users notice and switch.
 */

const { spawn } = require('child_process');
const path = require('path');

// v7.5.3: dropped the per-invocation deprecation banner per the
// "embedded by default, no commands required" UX mandate. Muscle-memory
// users continue to work with no friction; the wrapper is removed in
// v8.0.0 along with the rest of the bash sunset.

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
