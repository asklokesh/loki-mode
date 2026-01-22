# Loki Mode Installation Guide

Complete installation instructions for all platforms and use cases.

**Version:** v4.1.0

---

## Table of Contents

- [Quick Install (Recommended)](#quick-install-recommended)
- [npm (Node.js)](#npm-nodejs)
- [Homebrew (macOS/Linux)](#homebrew-macoslinux)
- [Docker](#docker)
- [Claude Code (CLI)](#claude-code-cli)
- [Claude.ai (Web)](#claudeai-web)
- [Anthropic API Console](#anthropic-api-console)
- [Verify Installation](#verify-installation)
- [Troubleshooting](#troubleshooting)

---

## Quick Install (Recommended)

Choose your preferred method:

```bash
# Option A: npm (easiest)
npm install -g loki-mode

# Option B: Homebrew (macOS/Linux)
brew tap asklokesh/tap && brew install loki-mode

# Option C: Docker
docker pull asklokesh/loki-mode:4.1.0

# Option D: Git clone
git clone https://github.com/asklokesh/loki-mode.git ~/.claude/skills/loki-mode
```

**Done!** Skip to [Verify Installation](#verify-installation).

---

## npm (Node.js)

Install via npm for the easiest setup with automatic PATH configuration.

### Prerequisites

- Node.js 16.0.0 or later

### Installation

```bash
# Global installation
npm install -g loki-mode

# The skill is automatically installed to ~/.claude/skills/loki-mode
```

### Usage

```bash
# Use the CLI
loki start ./my-prd.md
loki status
loki dashboard

# Or invoke in Claude Code
claude --dangerously-skip-permissions
> Loki Mode with PRD at ./my-prd.md
```

### Updating

```bash
npm update -g loki-mode
```

### Uninstalling

```bash
npm uninstall -g loki-mode
rm -rf ~/.claude/skills/loki-mode
```

---

## Homebrew (macOS/Linux)

Install via Homebrew with automatic dependency management.

### Prerequisites

- Homebrew (https://brew.sh)

### Installation

```bash
# Add the tap
brew tap asklokesh/tap

# Install Loki Mode
brew install loki-mode

# Set up Claude Code skill integration
loki-mode-install-skill
```

### Dependencies

Homebrew automatically installs:
- bash 4.0+ (for associative arrays)
- jq (JSON processing)
- gh (GitHub CLI for integration)

### Usage

```bash
# Use the CLI
loki start ./my-prd.md
loki status
loki --help
```

### Updating

```bash
brew upgrade loki-mode
```

### Uninstalling

```bash
brew uninstall loki-mode
rm -rf ~/.claude/skills/loki-mode
```

---

## Docker

Run Loki Mode in a container for isolated execution.

### Prerequisites

- Docker installed and running

### Installation

```bash
# Pull the image
docker pull asklokesh/loki-mode:4.1.0

# Or use docker-compose
curl -o docker-compose.yml https://raw.githubusercontent.com/asklokesh/loki-mode/main/docker-compose.yml
```

### Usage

```bash
# Run with a PRD file
docker run -v $(pwd):/workspace -w /workspace asklokesh/loki-mode:4.1.0 start ./my-prd.md

# Interactive mode
docker run -it -v $(pwd):/workspace -w /workspace asklokesh/loki-mode:4.1.0

# Using docker-compose
docker-compose run loki start ./my-prd.md
```

### Environment Variables

Pass your configuration via environment variables:

```bash
docker run -e LOKI_MAX_RETRIES=100 -e LOKI_BASE_WAIT=120 \
  -v $(pwd):/workspace -w /workspace \
  asklokesh/loki-mode:4.1.0 start ./my-prd.md
```

### Updating

```bash
docker pull asklokesh/loki-mode:latest
```

---

---

## Claude Code (CLI)

Loki Mode can be installed for Claude Code in three ways:

### Option A: Git Clone (Recommended)

**Personal installation (available in all projects):**
```bash
git clone https://github.com/asklokesh/loki-mode.git ~/.claude/skills/loki-mode
```

**Project-specific installation:**
```bash
# Navigate to your project directory first
cd /path/to/your/project

# Clone to local skills directory
git clone https://github.com/asklokesh/loki-mode.git .claude/skills/loki-mode
```

### Option B: Download from Releases

```bash
# Navigate to skills directory
cd ~/.claude/skills

# Get latest version number
VERSION=$(curl -s https://api.github.com/repos/asklokesh/loki-mode/releases/latest | grep tag_name | cut -d'"' -f4 | tr -d 'v')

# Download and extract
curl -L -o loki-mode.zip "https://github.com/asklokesh/loki-mode/releases/download/v${VERSION}/loki-mode-claude-code-${VERSION}.zip"
unzip loki-mode.zip && rm loki-mode.zip
```

**Result:** Creates `~/.claude/skills/loki-mode/SKILL.md`

### Option C: Minimal Install (curl)

If you only want the essential files without the full repository:

```bash
# Create directory structure
mkdir -p ~/.claude/skills/loki-mode/references

# Download core skill file
curl -o ~/.claude/skills/loki-mode/SKILL.md \
  https://raw.githubusercontent.com/asklokesh/loki-mode/main/SKILL.md

# Download agent definitions
curl -o ~/.claude/skills/loki-mode/references/agents.md \
  https://raw.githubusercontent.com/asklokesh/loki-mode/main/references/agents.md

# Download deployment guides
curl -o ~/.claude/skills/loki-mode/references/deployment.md \
  https://raw.githubusercontent.com/asklokesh/loki-mode/main/references/deployment.md

# Download business operations reference
curl -o ~/.claude/skills/loki-mode/references/business-ops.md \
  https://raw.githubusercontent.com/asklokesh/loki-mode/main/references/business-ops.md
```

**Note:** This minimal install won't include examples, tests, or the autonomous runner. Use Option A or B for full functionality.

---

## Claude.ai (Web)

For using Loki Mode on the Claude.ai web interface:

### Step 1: Download the Skill Package

1. Go to [Releases](https://github.com/asklokesh/loki-mode/releases)
2. Download **either**:
   - `loki-mode-X.X.X.zip` (standard format)
   - `loki-mode-X.X.X.skill` (skill format)

   Both contain the same skill and will work.

### Step 2: Upload to Claude.ai

1. Open [Claude.ai](https://claude.ai)
2. Go to **Settings** (gear icon)
3. Navigate to **Features → Skills**
4. Click **Upload Skill**
5. Select the downloaded `.zip` or `.skill` file

**File Structure:** The Claude.ai package has `SKILL.md` at the root level as required by the web interface.

---

## Anthropic API Console

For using Loki Mode through the Anthropic API Console (console.anthropic.com):

### Step 1: Download the API Package

1. Go to [Releases](https://github.com/asklokesh/loki-mode/releases)
2. Download **`loki-mode-api-X.X.X.zip`** (note the `-api-` version)

   **Important:** The API version has a different file structure than the web version.

### Step 2: Upload to API Console

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Navigate to **Skills** section
3. Click **Upload Skill**
4. Select the downloaded `loki-mode-api-X.X.X.zip` file

**File Structure:** The API package has `SKILL.md` inside a `loki-mode/` folder as required by the API.

---

## Verify Installation

### For Claude Code (CLI)

Check that the skill file is in place:

```bash
cat ~/.claude/skills/loki-mode/SKILL.md | head -10
```

**Expected output:** Should show YAML frontmatter starting with:
```yaml
---
name: loki-mode
description: Multi-Agent Autonomous Startup System
...
---
```

### For Claude.ai (Web)

1. Start a new conversation
2. Type: `Loki Mode`
3. Claude should recognize the skill and ask for a PRD

### For API Console

1. Create a new API call with skills enabled
2. Include the skill in your request
3. The skill should be available for use

---

## File Structure

After installation, you should have this structure:

```
loki-mode/
├── SKILL.md              # Main skill file (required)
├── README.md             # Documentation
├── docs/
│   └── INSTALLATION.md   # This file
├── CHANGELOG.md          # Version history
├── VERSION               # Current version number
├── LICENSE               # MIT License
├── references/           # Agent and deployment references
│   ├── agents.md
│   ├── deployment.md
│   └── business-ops.md
├── autonomy/             # Autonomous runner (CLI only)
│   ├── run.sh
│   └── README.md
├── examples/             # Sample PRDs for testing
│   ├── simple-todo-app.md
│   ├── api-only.md
│   ├── static-landing-page.md
│   └── full-stack-demo.md
├── tests/                # Test suite (CLI only)
│   ├── run-all-tests.sh
│   ├── test-bootstrap.sh
│   └── ...
└── integrations/         # Third-party integrations
    └── vibe-kanban.md
```

**Note:** Some files/directories (autonomy, tests, examples) are only available with full installation (Options A or B).

---

## Troubleshooting

### Skill Not Found

**Problem:** Claude doesn't recognize "Loki Mode" command.

**Solutions:**
1. **Check installation path:**
   ```bash
   ls -la ~/.claude/skills/loki-mode/SKILL.md
   ```

2. **Verify YAML frontmatter:**
   ```bash
   cat ~/.claude/skills/loki-mode/SKILL.md | head -5
   ```
   Should show `name: loki-mode`

3. **Restart Claude Code:**
   ```bash
   # Exit and restart claude command
   ```

### Permission Denied

**Problem:** Cannot create directories or download files.

**Solution:**
```bash
# Ensure skills directory exists
mkdir -p ~/.claude/skills

# Check permissions
ls -la ~/.claude/
```

### Download Fails

**Problem:** curl or wget commands fail.

**Solutions:**
1. **Check internet connection**

2. **Try alternate download method:**
   ```bash
   # Use wget instead of curl
   wget -O ~/.claude/skills/loki-mode/SKILL.md \
     https://raw.githubusercontent.com/asklokesh/loki-mode/main/SKILL.md
   ```

3. **Manual download:**
   - Visit the URL in a browser
   - Save file manually to `~/.claude/skills/loki-mode/`

### Autonomous Runner Won't Start

**Problem:** `./autonomy/run.sh` gives "command not found" or permission errors.

**Solutions:**
1. **Make executable:**
   ```bash
   chmod +x autonomy/run.sh
   ```

2. **Run from repository root:**
   ```bash
   # Make sure you're in the loki-mode directory
   cd ~/.claude/skills/loki-mode
   ./autonomy/run.sh
   ```

3. **Check prerequisites:**
   ```bash
   # Ensure Claude Code is installed
   claude --version

   # Ensure Python 3 is available
   python3 --version
   ```

### References Not Loading

**Problem:** Skill loads but agent definitions or deployment guides are missing.

**Solution:**
```bash
# Ensure all reference files are present
ls -la ~/.claude/skills/loki-mode/references/

# Should show:
# agents.md
# deployment.md
# business-ops.md

# If missing, download them:
curl -o ~/.claude/skills/loki-mode/references/agents.md \
  https://raw.githubusercontent.com/asklokesh/loki-mode/main/references/agents.md
```

---

## Updating Loki Mode

### For Git Installations

```bash
cd ~/.claude/skills/loki-mode
git pull origin main
```

### For Manual Installations

1. Download the latest release
2. Extract to the same directory (overwrite existing files)
3. Or delete old installation and reinstall

### Check Current Version

```bash
cat ~/.claude/skills/loki-mode/VERSION
```

---

## Uninstalling

### Claude Code (CLI)

```bash
# Remove the skill directory
rm -rf ~/.claude/skills/loki-mode
```

### Claude.ai (Web)

1. Go to **Settings → Features → Skills**
2. Find "loki-mode" in the list
3. Click **Remove**

### API Console

1. Go to **Skills** section
2. Find "loki-mode"
3. Click **Delete**

---

## Next Steps

After installation:

1. **Quick Test:** Run a simple example
   ```bash
   ./autonomy/run.sh examples/simple-todo-app.md
   ```

2. **Read Documentation:** Check out [README.md](README.md) for usage guides

3. **Create Your First PRD:** See the Quick Start section in README

4. **Join the Community:** Report issues or contribute at [GitHub](https://github.com/asklokesh/loki-mode)

---

## Need Help?

- **Issues/Bugs:** [GitHub Issues](https://github.com/asklokesh/loki-mode/issues)
- **Discussions:** [GitHub Discussions](https://github.com/asklokesh/loki-mode/discussions)
- **Documentation:** [README.md](README.md)

---

**Happy Building!**
