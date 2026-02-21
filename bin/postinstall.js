#!/usr/bin/env node
/**
 * Loki Mode postinstall script
 * Sets up the skill symlink for Claude Code, Codex CLI, and Gemini CLI
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const homeDir = os.homedir();
const packageDir = path.join(__dirname, '..');

const version = (() => {
  try { return fs.readFileSync(path.join(packageDir, 'VERSION'), 'utf8').trim(); }
  catch { return require(path.join(packageDir, 'package.json')).version; }
})();

console.log('');
console.log(`Loki Mode v${version} installed!`);
console.log('');

// Multi-provider skill targets
const skillTargets = [
  { dir: path.join(homeDir, '.claude', 'skills', 'loki-mode'), name: 'Claude Code' },
  { dir: path.join(homeDir, '.codex', 'skills', 'loki-mode'), name: 'Codex CLI' },
  { dir: path.join(homeDir, '.gemini', 'skills', 'loki-mode'), name: 'Gemini CLI' },
];

const results = [];

for (const target of skillTargets) {
  try {
    const skillParent = path.dirname(target.dir);

    if (!fs.existsSync(skillParent)) {
      fs.mkdirSync(skillParent, { recursive: true });
    }

    // Remove existing symlink/directory
    if (fs.existsSync(target.dir)) {
      const stats = fs.lstatSync(target.dir);
      if (stats.isSymbolicLink()) {
        fs.unlinkSync(target.dir);
      } else {
        // Existing real directory (not a symlink) - back it up and replace
        const backupDir = target.dir + '.backup.' + Date.now();
        console.log(`[WARNING] Existing non-symlink installation found at ${target.dir}`);
        console.log(`  Backing up to: ${backupDir}`);
        try {
          fs.renameSync(target.dir, backupDir);
        } catch (backupErr) {
          console.log(`  Could not back up: ${backupErr.message}`);
          results.push({ name: target.name, path: target.dir, ok: false });
          continue;
        }
      }
    }

    // Create symlink
    if (!fs.existsSync(target.dir)) {
      fs.symlinkSync(packageDir, target.dir);
    }
    results.push({ name: target.name, path: target.dir, ok: true });
  } catch (err) {
    results.push({ name: target.name, path: target.dir, ok: false, error: err.message });
  }
}

// Print summary
console.log('Skills installed:');
for (const r of results) {
  const icon = r.ok ? 'OK' : 'SKIP';
  const shortPath = r.path.replace(homeDir, '~');
  if (r.ok) {
    console.log(`  [${icon}] ${r.name.padEnd(12)} (${shortPath})`);
  } else {
    console.log(`  [${icon}] ${r.name.padEnd(12)} (${shortPath}) - ${r.error || 'backup failed'}`);
  }
}

if (results.some(r => !r.ok)) {
  console.log('');
  console.log('To fix missing symlinks:');
  console.log(`  loki setup-skill`);
}

console.log('');
console.log('CLI commands:');
console.log('  loki start ./prd.md              Start with Claude (default)');
console.log('  loki start --provider codex      Start with OpenAI Codex');
console.log('  loki start --provider gemini     Start with Google Gemini');
console.log('  loki status                      Check status');
console.log('  loki doctor                      Verify installation');
console.log('  loki --help                      Show all commands');
console.log('');

// Anonymous install telemetry (fire-and-forget, silent)
try {
  if (process.env.LOKI_TELEMETRY_DISABLED !== 'true' && process.env.DO_NOT_TRACK !== '1') {
    const https = require('https');
    const crypto = require('crypto');
    const idFile = path.join(homeDir, '.loki-telemetry-id');
    let distinctId;
    try {
      distinctId = fs.readFileSync(idFile, 'utf8').trim();
    } catch {
      distinctId = crypto.randomUUID();
      try { fs.writeFileSync(idFile, distinctId + '\n'); } catch {}
    }
    const payload = JSON.stringify({
      api_key: 'phc_ya0vGBru41AJWtGNfZZ8H9W4yjoZy4KON0nnayS7s87',
      event: 'install',
      distinct_id: distinctId,
      properties: {
        os: os.platform(),
        arch: os.arch(),
        version: version,
        channel: 'npm',
        node_version: process.version,
        providers_installed: results.filter(r => r.ok).map(r => r.name).join(','),
      },
    });
    const req = https.request({
      hostname: 'us.i.posthog.com',
      path: '/capture/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      timeout: 3000,
    });
    req.on('error', () => {});
    req.end(payload);
  }
} catch {}
