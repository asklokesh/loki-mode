# Providers

Multi-provider support for Claude Code, OpenAI Codex CLI, and Google Gemini CLI.

---

## Overview

Loki Mode supports three AI providers with different capability levels:

| Provider | Status | Task Tool | Parallel | MCP | Context |
|----------|--------|-----------|----------|-----|---------|
| **Claude** | Full | Yes | Yes (10+) | Yes | 200K |
| **Codex** | Degraded | No | No | No | 128K |
| **Gemini** | Degraded | No | No | No | 1M |

---

## Claude Code (Default)

Full-featured provider with complete Loki Mode capabilities.

### Installation

```bash
# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Authenticate
claude login
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
# "Loki Mode with PRD at ./my-prd.md"
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
codex auth
```

### Model

| Model | Context | Notes |
|-------|---------|-------|
| gpt-5.3-codex | 128K | Official model for Codex CLI v0.98+ |

### Invocation

```bash
# Recommended (v0.98.0+)
codex --full-auto

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

## Google Gemini CLI

Degraded mode with large context window.

### Installation

```bash
# Install Gemini CLI
npm install -g @google/gemini-cli

# Authenticate
gemini auth
```

### Model

| Model | Context | Notes |
|-------|---------|-------|
| gemini-3-pro-medium | 1M | Placeholder name |

### Invocation

```bash
# Autonomous mode (verified v0.27.3)
gemini --approval-mode=yolo "Your prompt here"

# Note: -p flag is DEPRECATED - use positional prompts instead
```

### Limitations

- No Task tool (sequential only)
- No parallel agents
- No MCP integration
- Single model

### Configuration

```bash
# Set as provider
loki provider set gemini

# Or via environment
export LOKI_PROVIDER=gemini

# Start with Gemini
loki start ./prd.md --provider gemini
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
#   gemini  (installed)
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
loki start ./prd.md --provider gemini
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

**Codex/Gemini:** Not supported
```
All tasks run sequentially in main context
```

### Parallel Execution

**Claude:** Git worktrees + parallel agents
```bash
export LOKI_PARALLEL_MODE=true
export LOKI_MAX_PARALLEL_SESSIONS=3
```

**Codex/Gemini:** Sequential only
```
Each task completes before next begins
```

### Context Window

| Provider | Context | Effective Use |
|----------|---------|---------------|
| Claude | 200K | Large codebases |
| Codex | 128K | Medium projects |
| Gemini | 1M | Very large files |

---

## Degraded Mode Behavior

When using Codex or Gemini:

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

### Use Gemini When:

- Very large context needed
- Google ecosystem preference
- Simple tasks with large files
- Cost optimization needed

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
claude login
codex auth
gemini auth
```

### Wrong Provider Used

```bash
# Check current provider
loki provider show

# Reset to default
loki provider set claude
```
