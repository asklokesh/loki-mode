# Providers

Loki is provider-agnostic: the autonomy loop is the product, and the coding CLI underneath is swappable. Supported providers: Claude Code, OpenAI Codex CLI, Cline, and Aider.

---

## Overview

Loki Mode supports four active AI providers with different capability levels, plus historical/upcoming entries:

| Provider | Status | Task Tool | Parallel | MCP | Context |
|----------|--------|-----------|----------|-----|---------|
| **Claude** | Active (Tier 1, Full, E2E-verified) | Yes | Yes (10+) | Yes | 200K |
| **Cline** | Experimental (Tier 2) - community-tested | No | No | No | varies |
| **Codex** | Experimental (Tier 3) - community-tested | No | No | No | 128K |
| **Aider** | Experimental (Tier 3) - community-tested | No | No | No | varies |
| **Google Gemini CLI** | DEPRECATED v7.5.18 | -- | -- | -- | -- |

**Status note (2026-06-09):** Claude Code is the primary, fully supported provider and the one Loki Mode is built for; it is the only provider we E2E-verify ourselves with real spec-to-code builds. Codex, Cline, and Aider have working wiring but no end-to-end verified build on our side, so they are labeled experimental (community-tested). Codex on a fresh non-git directory previously failed with "Not inside a trusted directory"; the harness now passes `--skip-git-repo-check`.

**Note on Gemini:** Upstream Gemini CLI was deprecated by Google. Loki removed the runtime in v7.5.18. `LOKI_PROVIDER=gemini` exits with a clear migration message pointing to Claude/Codex/Cline/Aider.

---

## Provider precedence (v7.7.2)

When multiple sources specify a provider, Loki picks the first match in this order (highest wins):

| Priority | Source | Scope | Example |
|---|---|---|---|
| 1 | `loki start --provider NAME` | Per-invocation CLI flag | `loki start --provider codex ./prd.md` |
| 2 | `.loki/state/provider` | Per-project saved value | `loki provider set claude` writes this file |
| 3 | `LOKI_PROVIDER` env var | Shell session default | `export LOKI_PROVIDER=cline` |
| 4 | `claude` | Built-in default | (no config) |

**Important:** `loki status` reflects the **SAVED** value, not the env var. If you set `LOKI_PROVIDER=cline` in your shell but ran `loki provider set claude` earlier in this project, `loki status` will show `claude`. To make a per-project choice persist, use `loki provider set NAME`.

`loki status --json` includes a `provider_source` field with values `"saved"`, `"env"`, or `"default"` so scripts can verify why a value was chosen.

---

## Claude Code (Default)

Full-featured provider with complete Loki Mode capabilities.

### Installation

```bash
# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Authenticate
claude auth login
```

### Models

| Tier | Model | Use Case |
|------|-------|----------|
| **Planning** | claude-opus-4-7 | Architecture, system design (1M context, adaptive thinking) |
| **Development** | claude-sonnet-4-6 | Implementation, testing (1M context) |
| **Fast** | claude-haiku-4-5 | Simple tasks, monitoring (200K context) |

### Invocation

```bash
# Launch Claude with autonomous permissions
claude --dangerously-skip-permissions

# In Claude:
# "Loki Mode with spec at ./my-prd.md"
```

### Capabilities

- **Task Tool** - Spawn subagents for parallel work
- **Parallel Agents** - Up to 10+ concurrent agents
- **MCP Integration** - Extended tool capabilities
- **Extended Thinking** - Deep reasoning for complex problems
- **3 Model Tiers** - Right-size for each task

### Configuration

```bash
# Set as default provider
loki provider set claude

# Or via environment
export LOKI_PROVIDER=claude
```

---

## OpenAI Codex CLI

Degraded mode with sequential execution only.

### Installation

```bash
# Install Codex CLI
npm install -g @openai/codex-cli

# Authenticate
codex login
```

### Model

| Model | Context | Notes |
|-------|---------|-------|
| gpt-5.3-codex | 128K | Official model for Codex CLI v0.98+ |

### Invocation

```bash
# What Loki's harness runs (codex 0.125+; the --skip-git-repo-check is
# required on fresh non-git directories). exec is non-interactive by default
# (approval: never), so --sandbox workspace-write alone keeps it autonomous.
codex exec --sandbox workspace-write --skip-git-repo-check

# Note: --full-auto was deprecated in codex v0.125+ and is gone from the help
# text; --sandbox workspace-write is the documented replacement.

# Legacy
codex exec --dangerously-bypass-approvals-and-sandbox
```

### Limitations

- No Task tool (sequential only)
- No parallel agents
- No MCP integration
- Single model (uses effort parameter)

### Configuration

```bash
# Set as provider
loki provider set codex

# Or via environment
export LOKI_PROVIDER=codex

# Start with Codex
loki start ./prd.md --provider codex
```

### Effort Parameter

Codex uses an effort parameter instead of model tiers:

```
effort: low    -> Quick responses
effort: medium -> Balanced (default)
effort: high   -> Thorough analysis
```

---

## Cline CLI

Degraded mode with sequential execution only.

### Installation

```bash
# Install Cline CLI
npm install -g cline
```

### Invocation

```bash
# Autonomous mode (what the runtime actually passes)
cline -y
```

### Limitations

- No Task tool (sequential only)
- No parallel agents
- No MCP integration

### Configuration

```bash
# Set as provider
loki provider set cline

# Or via environment
export LOKI_PROVIDER=cline

# Start with Cline
loki start ./prd.md --provider cline
```

---

## Aider

Degraded mode with sequential execution. Supports 18+ model backends.

### Installation

```bash
pip install aider-chat
```

### Invocation

```bash
aider --yes-always
```

### Limitations

- No Task tool (sequential only)
- No parallel agents
- No MCP integration

### Configuration

```bash
# Set as provider
loki provider set aider

# Or via environment
export LOKI_PROVIDER=aider

# Start with Aider
loki start ./prd.md --provider aider
```

---

## Provider Management

### Check Current Provider

```bash
loki provider show
# Output: Current provider: claude
```

### List Available Providers

```bash
loki provider list
# Output:
# Available providers:
#   claude  (installed, default)
#   codex   (installed)
#   cline   (installed)
#   aider   (installed)
```

### Get Provider Info

```bash
loki provider info claude
# Output:
# Provider: claude
# Status: Full features
# Model: claude-opus-4-7
# Context: 1M tokens
# Capabilities: Task tool, parallel, MCP, adaptive thinking
```

### Set Default Provider

```bash
# Persists across sessions
loki provider set codex
```

### Per-Session Override

```bash
# Override for single session
loki start ./prd.md --provider cline
```

---

## Feature Comparison

### Task Tool (Subagents)

**Claude:** Full support
```
Spawn up to 10+ parallel subagents for:
- Research tasks
- Code review
- Testing
- Documentation
```

**Codex/Cline/Aider:** Not supported
```
All tasks run sequentially in main context
```

### Parallel Execution

**Claude:** Git worktrees + parallel agents
```bash
export LOKI_PARALLEL_MODE=true
export LOKI_MAX_PARALLEL_SESSIONS=3
```

**Codex/Cline/Aider:** Sequential only
```
Each task completes before next begins
```

### Context Window

| Provider | Context | Effective Use |
|----------|---------|---------------|
| Claude | 200K | Large codebases |
| Codex | 128K | Medium projects |
| Cline | varies | Depends on backend model |
| Aider | varies | Depends on backend model |

---

## Degraded Mode Behavior

When using Codex, Cline, or Aider:

1. **No Parallel Agents** - Tasks run sequentially
2. **No Task Tool** - Cannot spawn subagents
3. **No MCP** - Limited to built-in tools
4. **Single Model** - No tier selection
5. **Longer Execution** - Same work takes more time

### Automatic Fallbacks

Loki Mode automatically adjusts when in degraded mode:

- Phases run sequentially instead of parallel
- Code review uses single pass instead of 3-reviewer
- Research tasks inline instead of background

---

## Provider Selection Guide

### Use Claude When:

- Complex multi-file changes
- Need parallel execution
- Require code review quality
- Using MCP integrations
- Speed is important

### Use Codex When:

- OpenAI ecosystem preference
- Simpler, focused tasks
- Cost optimization needed
- Sequential workflow acceptable

### Use Cline When:

- Flexible model backend needed
- Sequential workflow acceptable

### Use Aider When:

- 18+ model backend flexibility needed
- Sequential workflow acceptable

---

## Troubleshooting

### Provider Not Found

```bash
loki provider info codex
# Error: Provider 'codex' not installed

# Solution: Install the CLI
npm install -g @openai/codex-cli
```

### Authentication Failed

```bash
# Re-authenticate
claude auth login
codex login
```

### Wrong Provider Used

```bash
# Check current provider
loki provider show

# Reset to default
loki provider set claude
```
