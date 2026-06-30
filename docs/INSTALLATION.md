# Loki Mode Installation Guide

The flagship product of [Autonomi](https://www.autonomi.dev/). Loki Mode is a spec-driven autonomous builder with a built-in trust layer that takes any spec to a deployed product and verifies completion with evidence (quality gates plus a completion council), not just a "done" claim. Complete installation instructions for all platforms and use cases.

**Version:** v7.100.1

---

## What's New in v7.5.x

### Phase 1 RARV-C closure (shipped v7.5.0, default-on as of v7.5.3)
Phase 1 closure features now activate automatically when you run
`loki start` -- no env flags required. Power users can opt out by
setting any flag to `0`.

- `findings_injector.ts` -- structured per-finding records (severity, file,
  line, reviewer) injected into the next iteration's prompt instead of bare
  comma-separated tokens. Default: ON. Opt out with `LOKI_INJECT_FINDINGS=0`.
- `counter_evidence.ts` -- override council. Drop a
  `.loki/state/counter-evidence-<iter>.json` to dispute reviewer findings;
  approval lifts the BLOCK. Default: ON. Opt out with `LOKI_OVERRIDE_COUNCIL=0`.
- `learnings_writer.ts` -- automatic structured learnings to
  `.loki/state/relevant-learnings.json` on every code_review failure.
  Default: ON. Opt out with `LOKI_AUTO_LEARNINGS=0`.
- `escalation_handoff.ts` -- structured human-handoff doc to
  `.loki/escalations/handoff-*.md` before PAUSE. Default: ON. Opt out
  with `LOKI_HANDOFF_MD=0`.
- `loki status` shows a "Phase 1 artifacts" section when findings,
  learnings, or escalations exist (added v7.5.5; see the `phase1` block
  in `loki status --json`).
- See `skills/quality-gates.md` for full schema and reachability notes.

### Output-token compressor (caveman, default-on, Claude-only)
Loki integrates [caveman](https://github.com/JuliusBrussee/caveman), an optional
Claude Code skill that compresses the model's OUTPUT tokens only (keeping all
technical substance). It activates on free-form generation (the main RARV dev
loop) and is HARD-SUPPRESSED on every trust-gate subcall (council votes, code
review verdict, evidence-related parses) so determinism is never affected.
- Claude-provider-only; runs are byte-identical on Codex / Cline / Aider.
- Default on; opt out with `LOKI_CAVEMAN=0`.
- Level: `LOKI_CAVEMAN_LEVEL` (default `full`; also `lite`, `ultra`, `wenyan*`).
- Pinned + vendor-less: `LOKI_CAVEMAN_VERSION` (default `1.9.0`); Loki bootstraps
  the pinned version on demand (opt out `LOKI_CAVEMAN_AUTO_BOOTSTRAP=0`).
- Savings are output-token-only and bounded; Loki never quotes a dollar figure.
- See `skills/quality-gates.md` (Output-token compressor) for details.

### Earlier highlights still in scope
- Bash-to-Bun runtime migration in progress (see `UPGRADING.md`)
- Provider-agnostic runtime: Claude (full), Codex, Cline, Aider (no vendor lock-in)
- Memory system (episodic / semantic / procedural)
- ChromaDB semantic code search via MCP

---

## Table of Contents

- [Bun (Recommended)](#bun-recommended)
- [npm](#npm)
- [Homebrew](#homebrew)
- [Quick Start](#quick-start)
- [Verify Installation](#verify-installation)
- [Other Methods](#other-methods)
- [VS Code Extension (Deprecated)](#vs-code-extension-deprecated)
- [Sandbox Mode](#sandbox-mode)
- [Multi-Provider Support](#multi-provider-support)
- [Environment Variables](#environment-variables)
- [Claude Code (CLI)](#claude-code-cli)
- [Claude.ai (Web)](#claudeai-web)
- [Anthropic API Console](#anthropic-api-console)
- [Ports](#ports)
- [Shell Completions](#shell-completions)
- [Troubleshooting](#troubleshooting)

---

## Bun (Recommended)

```bash
bun install -g loki-mode
```

Installs the `loki` CLI. Bun is the recommended path: the `loki` shim runs the
faster TypeScript runtime when `bun` is on `PATH`, and the stable bash engine
(the autonomous loop, quality gates, and completion council) runs underneath on
every route, so you lose nothing by choosing Bun. Run `loki setup-skill` once
after install to create the per-provider skill symlinks (Claude Code, Codex CLI).

**Prerequisites:** Bun 1.3+ (`curl -fsSL https://bun.sh/install | bash`, or
`brew install oven-sh/bun/bun`). No separate Node install is required.

**Update:** `bun update -g loki-mode`

**Uninstall:** `bun remove -g loki-mode`

---

## npm

```bash
npm install -g loki-mode
```

A fully supported alternative when you prefer npm or do not have Bun. As of
v7.4.12 there is no postinstall step; run `loki setup-skill` once after install
to create the per-provider skill symlinks (Claude Code, Codex CLI). The `loki`
shim auto-routes read-only commands to the Bun runtime when `bun` is on `PATH`
and falls back to the bash CLI otherwise (the core autonomous engine is the
same on both routes).

**Prerequisites:** Node.js 18+. Bun 1.3+ optional but recommended for the
faster routed commands and forward-compat with v8.0.0.

**What it does:**
- Installs the `loki` CLI binary to your PATH (`bin/loki` shim)
- Subsequent `loki setup-skill` creates symlinks at `~/.claude/skills/loki-mode`, `~/.codex/skills/loki-mode`

**Anonymous telemetry is OPT-IN and OFF by default.** A default `npm install`
sends nothing, so air-gapped and enterprise installs are safe out of the box. To
opt in to anonymous diagnostics, run `loki telemetry on` or set
`LOKI_TELEMETRY=on`. To make opting in impossible across a fleet, bake an
opt-out into your base image (opt-out always wins):
```bash
# Hard-disable everywhere (belt and suspenders; opt-out always wins):
LOKI_TELEMETRY_DISABLED=true npm install -g loki-mode
# Or set DO_NOT_TRACK=1
```
See [PRIVACY.md](./PRIVACY.md) for the exact data sent and the full opt-in /
opt-out model.

**Update:** `npm update -g loki-mode`

**Uninstall:** `npm uninstall -g loki-mode`

---

## Homebrew

```bash
brew tap asklokesh/tap && brew install loki-mode
```

Installs the `loki` CLI. To also install the skill for interactive use with all providers:

```bash
loki setup-skill
```

**Update:** `brew upgrade loki-mode`

**Uninstall:** `brew uninstall loki-mode`

---

## PyPI / Python SDK

**The `loki` CLI is NOT available via `pip install loki-mode`.** PyPI hosts only the
Python REST client SDK at `loki-mode-sdk` (v7.4.18+). The dashboard, MCP server,
and orchestrator components ship via npm, Docker, and Homebrew only.

```bash
# Install the Python REST client only
pip install loki-mode-sdk

# Install the full CLI (recommended)
bun install -g loki-mode  # or: npm install -g loki-mode, or: brew tap asklokesh/tap && brew install loki-mode
```

The naming asymmetry (`loki-mode` on npm vs `loki-mode-sdk` on PyPI) is
intentional: PyPI's `loki-mode` namespace is reserved for a future server
package, while `loki-mode-sdk` is the thin client.

---

## Quick Start

New here? `loki quickstart` (v7.29.0) walks you through your first build in
four questions (setup check, one-line idea, template pick, plan review with
a real cost estimate before anything is spent). Pressing Enter at every step
builds the sample Todo app.

```bash
loki quickstart
```

Drop a spec -- any artifact that describes what you want built -- and Loki
Mode takes it from spec to deployed app. Specs can be a markdown PRD, a
GitHub issue URL, or a YAML feature description.

```bash
# CLI mode (works with any provider) -- spec as markdown PRD
loki start ./spec.md
loki start ./spec.md --provider codex
loki start ./spec.md --provider cline

# Spec as a GitHub issue
loki start --github-issue https://github.com/owner/repo/issues/42

# Spec as a YAML feature description
loki start ./feature.yaml

# Interactive mode (inside your coding agent)
claude --dangerously-skip-permissions
# Then say: "Loki Mode with spec at ./my-spec.md"
```

---

## Verify Installation

```bash
loki --version    # Should print the current version
loki doctor       # Check skill symlinks, providers, and system prerequisites
```

---

## Other Methods

Git clone and Docker installation methods are also available. See
[alternative-installations.md](alternative-installations.md) for details and
trade-offs.

---

## VS Code Extension (Deprecated)

> **DEPRECATED as of v7.2.0.** The Loki Mode VS Code extension is no longer
> maintained. Use the dashboard at `loki dashboard start` instead.
>
> The marketplace listing remains for users on v7.2.0 and earlier but will
> not receive further updates. The `vscode-extension/` source remains in the
> repository for contributors who want to build the extension locally; it is
> no longer published to the VS Code Marketplace and is not included in npm
> tarballs.

### Recommended replacement: the dashboard

```bash
loki dashboard start
# Then open http://localhost:57374 in your browser.
```

The dashboard provides session monitoring, task views, the completion
council, log streaming, and the managed-memory panel -- the same surface
the extension exposed, plus everything added since v7.2.0.

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
# Run in sandbox mode (spec can be PRD, issue link, or YAML)
./autonomy/sandbox.sh ./my-spec.md

# With provider selection
./autonomy/sandbox.sh --provider codex ./my-spec.md
```

### Security Controls

#### Prompt Injection Protection

By default, prompt injection is **disabled** for enterprise safety:

```bash
# Default: prompt injection disabled
./autonomy/run.sh ./my-spec.md

# Opt-in to enable prompt injection
LOKI_PROMPT_INJECTION_ENABLED=true ./autonomy/run.sh ./my-spec.md
```

#### Human Input Security

The `HUMAN_INPUT.md` file has security controls:
- **Symlink protection**: Symlinks are rejected
- **Size limit**: Maximum 1MB file size
- **Path validation**: Must be within `.loki/` directory

### When to Use Sandbox Mode

- Running untrusted spec files (PRD, issue export, YAML)
- Enterprise environments with strict security requirements
- Automated CI/CD pipelines
- Multi-tenant deployments

---

## Multi-Provider Support

Loki Mode supports four active providers across three tiers, plus historical/upcoming entries. Pick by capability + cost.

### Supported Providers

| Provider | Status | Tier | Notes |
|----------|--------|------|-------|
| `claude` | Active | Tier 1 (full) | Default. All features incl. Task subagents, MCP, council. |
| `cline`  | Active | Tier 2 | Full feature set; small models (<13B) may fail tool-use. |
| `codex`  | Active | Tier 3 (degraded) | Sequential only, no Task tool; aligned with `@openai/codex` v0.125+. |
| `aider`  | Active | Tier 3 (degraded) | Sequential only; `ollama_chat/<model>` works for local models. |
| `gemini` | DEPRECATED v7.5.18 | -- | Upstream Gemini CLI deprecated by Google. Runtime removed; `LOKI_PROVIDER=gemini` exits with migration message. |

### Configuration

#### Environment Variable

Set the `LOKI_PROVIDER` environment variable to select your provider:

```bash
# Use Claude (default)
export LOKI_PROVIDER=claude

# Use OpenAI Codex
export LOKI_PROVIDER=codex

# Use Cline
export LOKI_PROVIDER=cline
```

#### CLI Flag

Use the `--provider` flag when invoking Loki Mode:

```bash
# Use Claude (default)
loki start ./my-spec.md --provider claude

# Use OpenAI Codex
loki start ./my-spec.md --provider codex

# Use Cline
loki start ./my-spec.md --provider cline
```

#### Docker

Docker is where sandboxes and runs happen. The easiest way to run Loki in a
container is the `loki docker` host wrapper, which gives you the full local
experience (including `.loki/` state, resume, and continuity) in one command.
The raw `docker run` and `docker compose` methods below remain as alternatives.

##### loki docker (easiest)

If you have loki installed on the host (npm/brew/bun) plus Docker, `loki docker`
runs any loki command inside the published `asklokesh/loki-mode` image with zero
config:

```bash
loki docker start prd.md             # full local experience in Docker
loki docker status                   # any loki command works
loki docker --dry-run start prd.md   # print the docker command, do not run
```

It bind-mounts the current folder to `/workspace`, so `.loki/` state (memory,
session, queue, checkpoints) persists on the host and resume and continuity
behave exactly like the local `loki` CLI. Auth is auto-detected:
`ANTHROPIC_API_KEY` if set, else your host's existing Claude Code login
(Max/Pro subscribers need no API key), else an honest error with guidance. It
also forwards `~/.gitconfig` and `~/.config/gh` (read-only) plus
`GITHUB_TOKEN`/`GH_TOKEN` if set, so commits and PRs work like local, and
exposes the dashboard on port 57374. Use `--image IMG` to override the image.

`loki docker` is a thin host wrapper around the image; it requires loki and
Docker installed on the host.

Multi-repo + unified dashboard: you can run `loki docker start` in several
different repos at once, exactly like the host CLI. Each repo gets its own
container (deterministic name `loki-<hash-of-path>`) and its own bind-mounted
`.loki/` state. Every `loki docker` project registers with the host dashboard,
so running `loki dashboard` on the host shows ALL your projects in one unified
view, whether they run via local `loki start` or via `loki docker start`. Builds
run with the dashboard off by default (so concurrent runs do not collide on port
57374); use the host `loki dashboard`, or `loki docker start --api` for a single
containerized run's UI.

##### docker run

As of v7.45.0 the image ships the Claude Code CLI, so the default `claude`
provider works inside the container. Provide auth with your Anthropic API key:

```bash
# Run Loki Mode in Docker (Claude provider, API-key auth)
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v $(pwd):/workspace -w /workspace \
  asklokesh/loki-mode:7.93.0 start ./my-spec.md
```

##### docker compose + .env (no host install)

If you prefer not to install loki on the host, the repo ships a
`docker-compose.yml` with `env_file: .env`. Copy the example,
set your key once, then run without retyping long `-e` flags:

```bash
cp .env.example .env          # then edit .env and set ANTHROPIC_API_KEY
docker compose run loki start prd.md
```

`.env` is gitignored. Edit it and re-run any time; compose reloads it
automatically.

##### Host OAuth (Claude Code Max/Pro subscribers, no API key)

If you have a Claude Code subscription and no API key, you can reuse your host
login by mounting your credentials file at
`/home/loki/.claude/.credentials.json` instead of setting `ANTHROPIC_API_KEY`.
See [DOCKER_README.md](../DOCKER_README.md) "Option 2: host OAuth" for the
one-line export command and the compose volume to uncomment.

##### Other providers in Docker

The image ships only the Claude Code CLI. Codex, Cline, and Aider are
bring-your-own-CLI: install the provider CLI in a derived image (or mount it),
then select it with `-e LOKI_PROVIDER=<name>`. See
[DOCKER_README.md](../DOCKER_README.md) for details.

### Degraded Mode

When using `codex`, `cline`, or `aider` providers, Loki Mode operates in **degraded mode**:

- Core autonomous workflow functions normally
- Some advanced features may be unavailable or behave differently
- Model-specific optimizations (Opus/Sonnet/Haiku routing) are adapted for each provider
- Quality gates and RARV cycle remain fully functional

**Recommendation:** For the best experience and full feature support, use the default `claude` provider.

---

## Environment Variables

Loki Mode is designed to run with zero configuration: the trust-layer and
quality features below are default-on and decide intelligently by inspecting
the work. The environment variables here are opt-out escape hatches for power
users, not required setup. Set the documented value to disable a feature; leave
the variable unset to keep the intelligent default.

### Trust-gate and completion knobs (default-on)

These are read by the orchestrator (`autonomy/run.sh`) on every run.

- `LOKI_REVIEW_INCONCLUSIVE_BLOCK` (default `1`) -- when a code-review cycle
  returns zero usable verdicts (every reviewer produced empty output), the
  review is treated as INCONCLUSIVE and the gate BLOCKS, because an all-empty
  review proves nothing. A bounded one-shot retry runs first
  (`LOKI_REVIEW_RETRY`, default `1`). Set `LOKI_REVIEW_INCONCLUSIVE_BLOCK=0` to
  record the inconclusive result without blocking.

- `LOKI_COMPLETION_TEST_CAPTURE` (default `1`) -- before the verified-completion
  evidence gate runs, Loki captures a fresh `test-results.json` so the gate
  scores on real PASS/FAIL test results instead of a stale or missing file. It
  reuses this iteration's results if already fresh, and never crashes the
  completion path on red tests (the gate is the decider). Set
  `LOKI_COMPLETION_TEST_CAPTURE=0` to opt out.

- `LOKI_AUTO_DOCS` (default `true`) -- auto-generates the `.loki/docs/` suite
  before the documentation gate evaluates, so the gate scores on real generated
  docs instead of nagging you to run `loki docs generate` by hand. Bounded:
  runs at most once per run when docs are missing, and again only when existing
  docs are substantially stale; best-effort, never fails the iteration loop.
  Set `LOKI_AUTO_DOCS=false` to opt out.

### Output-token compressor (caveman, Claude-only)

Loki integrates [caveman](https://github.com/JuliusBrussee/caveman), an optional
Claude Code skill that compresses the model's OUTPUT tokens only (keeping all
technical substance). It activates on free-form generation (the main RARV dev
loop) and is HARD-SUPPRESSED on every trust-gate subcall (council votes, code
review verdicts, evidence-related parses) so determinism is never affected. It
is Claude-provider-only; runs are byte-identical on Codex / Cline / Aider. These
variables are read in `autonomy/lib/claude-flags.sh`.

- `LOKI_CAVEMAN` (default on) -- set `LOKI_CAVEMAN=0` to disable the compressor.
  Suppression on trust-gate subcalls is unconditional and applies even when
  caveman is globally installed but `LOKI_CAVEMAN=0`, so trust gates are never
  exposed to compression.

- `LOKI_CAVEMAN_LEVEL` (default `full`) -- the compression level for free-form
  activation. When you do NOT set this, the level is inferred per-invocation
  from the run's RARV tier (planning -> `lite`, development/fast -> `full`); the
  auto path never selects `ultra`. Setting `LOKI_CAVEMAN_LEVEL` explicitly
  overrides the inference entirely (the opt-out escape hatch).

- `LOKI_CAVEMAN_VERSION` (default `1.9.0`) -- the pinned caveman version used by
  the one-time bootstrap. Bump only to upgrade the compressor.

### RARV-C closure knobs (default-on)

The Phase 1 / RARV-C closure loop (findings injection, override council,
learnings writer, handoff doc) is default-on and documented in detail at the
top of this guide under [Phase 1 RARV-C closure](#phase-1-rarv-c-closure-shipped-v750-default-on-as-of-v753):
`LOKI_INJECT_FINDINGS`, `LOKI_OVERRIDE_COUNCIL`, `LOKI_AUTO_LEARNINGS`, and
`LOKI_HANDOFF_MD` (each opt out with `=0`). For the full schema and
reachability notes, see `skills/quality-gates.md`.

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
description: Autonomous Spec-to-Product System (RARV-C closure loop)
...
---
```

### For Claude.ai (Web)

1. Start a new conversation
2. Type: `Loki Mode`
3. Claude should recognize the skill and ask for a spec (PRD, GitHub issue link, or YAML)

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
├── LICENSE               # Business Source License 1.1
├── references/           # Agent and deployment references
│   ├── agents.md
│   ├── deployment.md
│   └── business-ops.md
├── autonomy/             # Autonomous runner (CLI only)
│   ├── run.sh
│   └── README.md
├── templates/            # 22 spec templates (PRD-style) for project scaffolding
│   ├── simple-todo-app.md
│   ├── api-only.md
│   ├── static-landing-page.md
│   └── ... (22 templates total)
├── tests/                # Test suite (CLI only)
│   ├── run-all-tests.sh
│   ├── test-bootstrap.sh
│   └── ...
└── integrations/         # Third-party integrations
    └── vibe-kanban.md
```

**Note:** Some files/directories (autonomy, tests, templates) are only available with full installation (Options A or B).

---

## Ports

Loki Mode uses two network ports for different services:

| Port | Service | Description |
|------|---------|-------------|
| **57374** | Dashboard + API (FastAPI) | Unified server serving both the web dashboard UI (real-time monitoring, task board, Completion Council, memory browser, log streaming) and the REST API (used by CLI tools, programmatic access, and the deprecated VS Code extension). Served by `dashboard/server.py`. |

### When to Use Which Port

- **Browser access** (dashboard, monitoring): Use port **57374** -- `http://localhost:57374`
- **API calls** (REST, programmatic): Use port **57374** -- `http://localhost:57374`
- **VS Code extension** (deprecated as of v7.2.0): Connects to API on port **57374** automatically (configurable via `loki.apiPort` setting). No new releases will be published; see the deprecation notice above.
- The server is started automatically when you run `loki start` or `./autonomy/run.sh`. No manual configuration is needed.

### Port Configuration

```bash
# Dashboard port (default: 57374)
LOKI_DASHBOARD_PORT=57374 loki dashboard start

# API port (default: 57374)
loki api start --port 57374   # was: loki serve
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
# npm install: use the npm package path
source "$(npm root -g)/loki-mode/completions/loki.bash"

# git clone: use the skills directory
source ~/.claude/skills/loki-mode/completions/loki.bash
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

  * `loki start --provider <TAB>` shows only installed providers (`claude`, `codex`, `cline`, `aider`).
  * `loki start <TAB>` defaults to file completion for spec files (PRD templates, YAML).

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

1. **Verify Setup:** Check your environment is ready
   ```bash
   loki doctor
   ```

2. **Scaffold a Project:** Create a project from a template
   ```bash
   loki init my-app --template simple-todo-app
   cd my-app
   ```

3. **Start Building:** Launch autonomous development from any spec (PRD, GitHub issue, or YAML)
   ```bash
   loki start spec.md
   ```

4. **Read Documentation:** Check out [README.md](../README.md) for usage guides

5. **Join the Community:** Report issues or contribute at [GitHub](https://github.com/asklokesh/loki-mode)

---

## Release Operations

### Token Rotation Runbook

Follow this runbook when a release workflow fails to publish to npm.

**Symptom:** The `publish-npm` step in `.github/workflows/release.yml` fails with:
```
npm error 404 Not Found - PUT https://registry.npmjs.org/loki-mode
```

A 404 on PUT means the registry rejected the credential, not that the package is missing.

**Likely causes:**
- The `NPM_TOKEN` Automation token has expired.
- The token was revoked or its owner lost publish rights on the `loki-mode` package.
- The npm account requires a 2FA refresh and the existing Automation token is no longer accepted.

**Remediation steps:**
1. Log in to npmjs.com as the publish account and regenerate an Automation token with publish access scoped to `loki-mode`.
2. Open https://github.com/asklokesh/loki-mode/settings/secrets/actions
3. Update the `NPM_TOKEN` repository secret with the new token value.
4. Re-run the failed Release workflow: `gh run rerun <run-id>`. If re-run is not available for that run, push a no-op commit to `main` to retrigger.

**Verification:**
- Watch the new run: `gh run watch <new-run-id>` and confirm `publish-npm` and `publish-ts-sdk` succeed.
- Confirm publish: `npm view loki-mode version` returns the new version.

**Note on `publish-ts-sdk`:** This job publishes `sdk/typescript` to npm and uses the same `secrets.NPM_TOKEN` as `publish-npm` (see `.github/workflows/release.yml`). Rotating `NPM_TOKEN` fixes both jobs. The new Automation token must have publish access to both the `loki-mode` package and the TypeScript SDK package.

---

## Need Help?

- **Issues/Bugs:** [GitHub Issues](https://github.com/asklokesh/loki-mode/issues)
- **Discussions:** [GitHub Discussions](https://github.com/asklokesh/loki-mode/discussions)
- **Documentation:** [README.md](../README.md)

---

**Happy Building!**
