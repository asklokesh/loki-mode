# Loki Mode Installation Guide

Complete installation instructions for all platforms and use cases.

**Version:** v5.42.1

---

## What's New in v5.39.0

### Enterprise Security (v5.36.0-v5.37.1)
- TLS/HTTPS support for dashboard connections
- OIDC/SSO authentication (Google, Azure AD, Okta)
- RBAC roles (admin, operator, viewer, auditor)
- WebSocket authentication for real-time connections
- Syslog forwarding for SIEM integration
- Non-root Docker with SETUID/SETGID removed
- Salted token hashing and rate limiting

### Monitoring & Observability (v5.38.0)
- Prometheus/OpenMetrics `/metrics` endpoint with 9 metrics
- `loki metrics` CLI command
- Agent action audit trail at `.loki/logs/agent-audit.jsonl`
- `loki audit` CLI with log/count subcommands
- SHA-256 chain-hashed tamper-evident audit entries

### Workflow Protection (v5.38.0)
- Branch protection: agent sessions auto-create feature branches
- PR creation via `gh` on session completion
- OpenClaw bridge foundation for external integrations
- Network security documentation (Docker/Kubernetes)

---

## Table of Contents

- [Quick Install (Recommended)](#quick-install-recommended)
- [VS Code Extension](#vs-code-extension)
- [npm (Node.js)](#npm-nodejs)
- [Homebrew (macOS/Linux)](#homebrew-macoslinux)
- [Docker](#docker)
- [Sandbox Mode](#sandbox-mode)
- [Multi-Provider Support](#multi-provider-support)
- [Claude Code (CLI)](#claude-code-cli)
- [Claude.ai (Web)](#claudeai-web)
- [Anthropic API Console](#anthropic-api-console)
- [Verify Installation](#verify-installation)
- [Ports](#ports)
- [Shell Completions](#shell-completions)
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
docker pull asklokesh/loki-mode:5.32.0

# Option D: Git clone
git clone https://github.com/asklokesh/loki-mode.git ~/.claude/skills/loki-mode
```

**Done!** Skip to [Verify Installation](#verify-installation).

---

## VS Code Extension

The easiest way to use Loki Mode with a visual interface.

### Installation

**From VS Code:**
1. Open Extensions (`Cmd+Shift+X` / `Ctrl+Shift+X`)
2. Search for "loki-mode"
3. Click **Install**

**From Command Line:**
```bash
code --install-extension asklokesh.loki-mode
```

**From Marketplace:**
Visit [marketplace.visualstudio.com/items?itemName=asklokesh.loki-mode](https://marketplace.visualstudio.com/items?itemName=asklokesh.loki-mode)

### Features

- **Activity Bar Icon**: Dedicated Loki Mode panel in the sidebar
- **Session View**: Real-time session status, provider, phase, and duration
- **Task View**: Tasks grouped by status (In Progress, Pending, Completed)
- **Status Bar**: Current state and progress at a glance
- **Quick Actions**: Start/Stop/Pause/Resume from command palette
- **Keyboard Shortcut**: `Cmd+Shift+L` (Mac) / `Ctrl+Shift+L` (Windows/Linux)

### Usage

1. Open a project folder in VS Code
2. Click the Loki Mode icon in the activity bar (or press `Cmd+Shift+L`)
3. Click "Start Session" and select your PRD file
4. Choose your AI provider (Claude, Codex, or Gemini)
5. Watch progress in the sidebar and status bar

### Configuration

Open VS Code Settings and search for "loki":

| Setting | Default | Description |
|---------|---------|-------------|
| `loki.provider` | `claude` | Default AI provider |
| `loki.apiPort` | `57374` | API server port |
| `loki.apiHost` | `localhost` | API server host |
| `loki.autoConnect` | `true` | Auto-connect on activation |
| `loki.showStatusBar` | `true` | Show status bar item |
| `loki.pollingInterval` | `2000` | Status polling interval (ms) |

### Requirements

**The VS Code extension requires the Loki Mode API server to be running.**

Before using the extension, start the server:

```bash
# Option A: Using Loki CLI (if installed via npm or Homebrew)
loki start

# Option B: Using the autonomous runner (from source)
./autonomy/run.sh

# Option C: Direct API server start
loki serve
```

The extension will automatically connect when it detects the server is running at `localhost:57374`.

**Troubleshooting:** If you see "API server is not running" errors, make sure you started the server first using one of the commands above.

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
docker pull asklokesh/loki-mode:5.32.0

# Or use docker-compose
curl -o docker-compose.yml https://raw.githubusercontent.com/asklokesh/loki-mode/main/docker-compose.yml
```

### Usage

```bash
# Run with a PRD file
docker run -v $(pwd):/workspace -w /workspace asklokesh/loki-mode:5.32.0 start ./my-prd.md

# Interactive mode
docker run -it -v $(pwd):/workspace -w /workspace asklokesh/loki-mode:5.32.0

# Using docker-compose
docker-compose run loki start ./my-prd.md
```

### Environment Variables

Pass your configuration via environment variables:

```bash
docker run -e LOKI_MAX_RETRIES=100 -e LOKI_BASE_WAIT=120 \
  -v $(pwd):/workspace -w /workspace \
  asklokesh/loki-mode:5.32.0 start ./my-prd.md
```

### Updating

```bash
docker pull asklokesh/loki-mode:latest
```

---

## Sandbox Mode

Run Loki Mode in an isolated Docker container for enhanced security.

### Features

- **Docker isolation**: Complete process isolation from host system
- **Seccomp profiles**: Restricted system calls
- **Resource limits**: CPU, memory, and process limits enforced
- **Dropped capabilities**: Minimal Linux capabilities
- **Read-only rootfs**: Immutable container filesystem
- **Git worktree fallback**: Automatic fallback when Docker unavailable

### Usage

```bash
# Run in sandbox mode
./autonomy/sandbox.sh ./my-prd.md

# With provider selection
./autonomy/sandbox.sh --provider codex ./my-prd.md
```

### Security Controls

#### Prompt Injection Protection

By default, prompt injection is **disabled** for enterprise safety:

```bash
# Default: prompt injection disabled
./autonomy/run.sh ./my-prd.md

# Opt-in to enable prompt injection
LOKI_PROMPT_INJECTION_ENABLED=true ./autonomy/run.sh ./my-prd.md
```

#### Human Input Security

The `HUMAN_INPUT.md` file has security controls:
- **Symlink protection**: Symlinks are rejected
- **Size limit**: Maximum 1MB file size
- **Path validation**: Must be within `.loki/` directory

### When to Use Sandbox Mode

- Running untrusted PRD files
- Enterprise environments with strict security requirements
- Automated CI/CD pipelines
- Multi-tenant deployments

---

## Multi-Provider Support

Loki Mode v5.0.0 introduces support for multiple AI providers beyond Claude.

### Supported Providers

| Provider | Status | Notes |
|----------|--------|-------|
| `claude` | Full Support | Default provider, all features available |
| `codex` | Degraded Mode | Core functionality only, some features unavailable |
| `gemini` | Degraded Mode | Core functionality only, some features unavailable |

### Configuration

#### Environment Variable

Set the `LOKI_PROVIDER` environment variable to select your provider:

```bash
# Use Claude (default)
export LOKI_PROVIDER=claude

# Use OpenAI Codex
export LOKI_PROVIDER=codex

# Use Google Gemini
export LOKI_PROVIDER=gemini
```

#### CLI Flag

Use the `--provider` flag when invoking Loki Mode:

```bash
# Use Claude (default)
loki start ./my-prd.md --provider claude

# Use OpenAI Codex
loki start ./my-prd.md --provider codex

# Use Google Gemini
loki start ./my-prd.md --provider gemini
```

#### Docker

Pass the provider as an environment variable:

```bash
# Use Codex with Docker
docker run -e LOKI_PROVIDER=codex \
  -v $(pwd):/workspace -w /workspace \
  asklokesh/loki-mode:5.32.0 start ./my-prd.md

# Use Gemini with Docker
docker run -e LOKI_PROVIDER=gemini \
  -v $(pwd):/workspace -w /workspace \
  asklokesh/loki-mode:5.32.0 start ./my-prd.md
```

### Degraded Mode

When using `codex` or `gemini` providers, Loki Mode operates in **degraded mode**:

- Core autonomous workflow functions normally
- Some advanced features may be unavailable or behave differently
- Model-specific optimizations (Opus/Sonnet/Haiku routing) are adapted for each provider
- Quality gates and RARV cycle remain fully functional

**Recommendation:** For the best experience and full feature support, use the default `claude` provider.

---

## Claude Code (CLI)

Loki Mode can be installed as a skill in three ways:

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
curl -o ~/.claude/skills/loki-mode/references/agent-types.md \
  https://raw.githubusercontent.com/asklokesh/loki-mode/main/references/agent-types.md

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

## Ports

Loki Mode uses two network ports for different services:

| Port | Service | Description |
|------|---------|-------------|
| **57374** | Dashboard + API (FastAPI) | Unified server serving both the web dashboard UI (real-time monitoring, task board, Completion Council, memory browser, log streaming) and the REST API (used by VS Code extension, CLI tools, programmatic access). Served by `dashboard/server.py`. |

### When to Use Which Port

- **Browser access** (dashboard, monitoring): Use port **57374** -- `http://localhost:57374`
- **API calls** (REST, programmatic): Use port **57374** -- `http://localhost:57374`
- **VS Code extension**: Connects to API on port **57374** automatically (configurable via `loki.apiPort` setting)
- The server is started automatically when you run `loki start` or `./autonomy/run.sh`. No manual configuration is needed.

### Port Configuration

```bash
# Dashboard port (default: 57374)
LOKI_DASHBOARD_PORT=57374 loki dashboard start

# API port (default: 57374)
loki serve --port 57374
```

### CORS Configuration

For remote or cross-origin access to the dashboard, configure allowed origins via the `LOKI_DASHBOARD_CORS` environment variable:

```bash
# Allow specific origins
LOKI_DASHBOARD_CORS="http://localhost:3000,https://my-dashboard.example.com" loki dashboard start

# Default: http://localhost:57374,http://127.0.0.1:57374 (localhost-only, secure by default)
```

---

## Shell Completions

Enable tab completion for the `loki` CLI to support subcommands, flags, and file arguments.

---

## Bash Setup

### Option 1: Permanent Setup (Recommended)

Add the source command to your startup file so completions load every time you open a terminal.

Add this line to your `~/.bashrc` (Linux) or `~/.bash_profile` (macOS):

```bash
source /path/to/loki/completions/loki.bash
```

---

### Option 2: Manual Sourcing (Temporary)

If you only want to enable completions for your current terminal session (for example, for testing), run:

```bash
source completions/loki.bash
```

---

### Optional: Smoother Bash Experience

By default, Bash requires two **TAB** presses to show the completion menu. To make it instant (similar to Zsh) and cycle through options more easily, add the following lines to your `~/.inputrc` file:

```bash
# Show menu immediately on first TAB
set show-all-if-ambiguous on

# Case-insensitive completion (optional)
set completion-ignore-case on
```

> **Note:** You will need to restart your terminal for `~/.inputrc` changes to take effect.

---

## Zsh Setup

Zsh completions require the script to be located in a directory listed in your `$fpath`.

### Permanent Setup

Add the `loki` completions directory to your `$fpath` in `~/.zshrc` **before** initializing completions:

```bash
# 1. Add the completions directory to fpath
fpath=(/path/to/loki/completions $fpath)

# 2. Initialize completions
autoload -Uz compinit && compinit
```

---

## Testing Completions

After installation, restart your shell or source your configuration file, then verify:

### Bash

```bash
loki <TAB>            # Should immediately list subcommands
loki start -<TAB>     # Should list flags (--provider, --parallel, etc.)
```

### Zsh

```bash
loki <TAB>                # Should show subcommands with descriptions
loki start --pro<TAB>     # Should autocomplete to --provider
```

---

## Completion Features

The completion scripts support:

* **Subcommands**
  `start`, `stop`, `pause`, `resume`, `status`, `dashboard`, `import`, `council`, `memory`, `provider`, `config`, `audit`, `metrics`, `watchdog`, `secrets`, `help`, `completions`

* **Smart Context**

  * `loki start --provider <TAB>` shows only installed providers (`claude`, `codex`, `gemini`).
  * `loki start <TAB>` defaults to file completion for PRD templates.

* **Nested Commands**
  Handles specific subcommands for `council`, `memory`, `config`, `audit`, `metrics`, `watchdog`, and `secrets`.

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
curl -o ~/.claude/skills/loki-mode/references/agent-types.md \
  https://raw.githubusercontent.com/asklokesh/loki-mode/main/references/agent-types.md
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
