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

// PATH check: warn if npm global bin is not in PATH, and auto-fix on macOS Homebrew
try {
  const { execSync } = require('child_process');
  const npmBin = execSync('npm bin -g 2>/dev/null || npm prefix -g', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const npmBinDir = npmBin.endsWith('/bin') ? npmBin : npmBin + '/bin';
  const pathDirs = (process.env.PATH || '').split(':');
  const lokiBinInPath = pathDirs.some(d => d === npmBinDir || d === npmBin);

  // On macOS with Homebrew Node, npm global bin path changes on every Node version upgrade
  // (e.g., /opt/homebrew/Cellar/node/22.x/bin -> /opt/homebrew/Cellar/node/23.x/bin).
  // Use the npm prefix bin directory which is stable across upgrades.
  if (os.platform() === 'darwin') {
    let stableDir;
    try {
      stableDir = execSync('npm prefix -g', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() + '/bin';
    } catch {
      stableDir = '/opt/homebrew/bin';
    }
    if (fs.existsSync(stableDir) && stableDir !== npmBinDir) {
      for (const bin of ['loki', 'loki-mode']) {
        const src = path.join(npmBinDir, bin);
        const dest = path.join(stableDir, bin);
        try {
          if (fs.existsSync(src)) {
            // Remove stale symlink or existing file
            try { fs.unlinkSync(dest); } catch {}
            fs.symlinkSync(src, dest);
          }
        } catch {
          // Silently skip if no permission (non-root)
        }
      }
    }
  }

  if (!lokiBinInPath) {
    console.log('');
    console.log('[IMPORTANT] The `loki` command may not be in your PATH.');
    console.log('');
    console.log('Add the npm global bin directory to your PATH:');
    console.log(`  export PATH="${npmBinDir}:$PATH"`);
    console.log('');
    console.log('To make this permanent, add it to your shell config (~/.zshrc or ~/.bashrc):');
    console.log(`  echo 'export PATH="${npmBinDir}:$PATH"' >> ~/.zshrc && source ~/.zshrc`);
    console.log('');
    console.log('Or use the Homebrew tap (sets PATH automatically):');
    console.log('  brew tap asklokesh/tap && brew install loki-mode');
  }
} catch {
  // If npm bin check fails, skip PATH warning silently
}

// Install Python dependencies for Purple Lab (pexpect, watchdog, httpx)
try {
  const { execSync } = require('child_process');
  const pyDeps = ['pexpect', 'watchdog', 'httpx'];
  // Check if deps are already installed
  const missing = pyDeps.filter(dep => {
    try {
      execSync(`python3 -c "import ${dep}"`, { stdio: 'pipe' });
      return false;
    } catch { return true; }
  });
  if (missing.length > 0) {
    console.log(`Installing Python dependencies: ${missing.join(', ')}...`);
    try {
      execSync(`python3 -m pip install --break-system-packages ${missing.join(' ')}`, { stdio: 'pipe', timeout: 60000 });
      console.log('  [OK] Python dependencies installed');
    } catch {
      try {
        execSync(`python3 -m pip install ${missing.join(' ')}`, { stdio: 'pipe', timeout: 60000 });
        console.log('  [OK] Python dependencies installed');
      } catch {
        console.log(`  [WARN] Could not install Python deps. Run: pip install ${missing.join(' ')}`);
      }
    }
  }
} catch {
  // Python not available, skip silently
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
