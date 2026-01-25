#!/usr/bin/env node
/**
 * Loki Mode postinstall script
 * Sets up the skill symlink for Claude Code, Codex CLI, and Gemini CLI
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const homeDir = os.homedir();
const skillDir = path.join(homeDir, '.claude', 'skills', 'loki-mode');
const packageDir = path.join(__dirname, '..');

console.log('');
console.log('Loki Mode v5.1.3 installed!');
console.log('');

// Try to create skill symlink
try {
  const skillParent = path.dirname(skillDir);

  if (!fs.existsSync(skillParent)) {
    fs.mkdirSync(skillParent, { recursive: true });
  }

  // Remove existing symlink/directory
  if (fs.existsSync(skillDir)) {
    const stats = fs.lstatSync(skillDir);
    if (stats.isSymbolicLink()) {
      fs.unlinkSync(skillDir);
    } else {
      console.log(`Existing installation found at ${skillDir}`);
      console.log('Please remove it manually if you want to use this npm installation.');
      console.log('');
    }
  }

  // Create symlink
  if (!fs.existsSync(skillDir)) {
    fs.symlinkSync(packageDir, skillDir);
    console.log(`Skill installed to: ${skillDir}`);
  }
} catch (err) {
  console.log(`Could not auto-install skill: ${err.message}`);
  console.log('');
  console.log('Manual installation:');
  console.log(`  ln -sf "${packageDir}" "${skillDir}"`);
}

console.log('');
console.log('Usage:');
console.log('  loki start [PRD]              - Start with Claude (default)');
console.log('  loki start --provider codex   - Start with OpenAI Codex');
console.log('  loki start --provider gemini  - Start with Google Gemini');
console.log('  loki status                   - Check status');
console.log('  loki --help                   - Show all commands');
console.log('');
console.log('Providers:');
console.log('  claude  - Full features (parallel agents, Task tool, MCP)');
console.log('  codex   - Degraded mode (sequential only)');
console.log('  gemini  - Degraded mode (sequential only)');
console.log('');
console.log('Or in Claude Code:');
console.log('  claude --dangerously-skip-permissions');
console.log('  Then say: "Loki Mode"');
console.log('');
