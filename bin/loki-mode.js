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

// Deprecation banner. Suppressed when piped (so scripts don't get noise) and
// when LOKI_NO_BANNER=1 / NO_COLOR is set (already-aware users).
if (
  process.stderr.isTTY &&
  !process.env.LOKI_NO_BANNER &&
  !process.env.NO_COLOR
) {
  process.stderr.write(
    '[loki-mode] DEPRECATED: this binary is being removed in v8.0.0. ' +
    'Use `loki` instead -- same behaviour, shorter name.\n',
  );
}

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
