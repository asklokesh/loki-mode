# Providers

Loki is provider-agnostic: the autonomy loop is the product, and the coding CLI underneath is swappable. Supported providers: Claude Code (including the Anthropic Agent SDK path for API-key users) and opencode (any model, including OpenRouter).

---

## Overview

| Provider | Status | Task Tool | Parallel | MCP | Context | Degraded |
|----------|--------|-----------|----------|-----|---------|----------|
| **Claude** (`--provider claude`) | Active (Tier 1, Full, E2E-verified) | Yes | Yes | Yes | 1M | No |
| **opencode** (`--provider opencode`) | Active (model-agnostic, OpenRouter) | No | No | Yes | varies | No |

Source: `providers/*.sh` (`PROVIDER_HAS_PARALLEL`, `PROVIDER_MAX_PARALLEL`, `PROVIDER_HAS_MCP`, `PROVIDER_CONTEXT_WINDOW`, `PROVIDER_DEGRADED`).

**Anthropic API key, no CLI login:** the claude provider also runs through the Anthropic Agent SDK (`@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`). Set `ANTHROPIC_API_KEY` and keep `--provider claude`.

**Removed providers:** codex, cline, aider and gemini are no longer supported. `--provider <name>` or `LOKI_PROVIDER=<name>` for any of them exits 2 with one line:

```
loki: provider 'codex' is no longer supported. Supported providers: claude (Claude Code CLI, or an Anthropic API key through the Agent SDK) and opencode (any model, including OpenRouter via OPENROUTER_API_KEY). Switch with --provider claude or --provider opencode, or unset LOKI_PROVIDER.
```

---

## MiniMax API compatibility

The `minimax` model catalog entry records API and model metadata. It is not a value for `--provider`; use the claude provider with the Anthropic-compatible API, or opencode. MiniMax-M3.1-Flash is the development/fast recommendation; MiniMax-M3 remains the planning option. Both support text, image, and video input with a 1M context window. Explicit saved or custom model IDs remain usable; the catalog is not an allowlist.

### Anthropic-compatible API

Choose the Base URL for the account region. Keep `/anthropic` as the end of the Base URL; the client appends `/v1/messages` when it sends a request.

| Region | Base URL |
|--------|----------|
| Global | `https://api.minimax.io/anthropic` |
| China | `https://api.minimaxi.com/anthropic` |

```bash
export ANTHROPIC_BASE_URL="https://api.minimax.io/anthropic"
export ANTHROPIC_API_KEY="<MINIMAX_API_KEY>"
export LOKI_MODEL_OVERRIDE="MiniMax-M3.1-Flash"
loki start ./prd.md --provider claude
```

Set `ANTHROPIC_BASE_URL` to the China Base URL when required. Change `LOKI_MODEL_OVERRIDE` to `MiniMax-M3` to use that model. Keep the explicit model override: setting an endpoint alone does not select a MiniMax model.

### Through opencode or OpenRouter

Use opencode with an OpenRouter route, for example `loki start ./prd.md --provider opencode --model openrouter/minimax/minimax-m3`, with `OPENROUTER_API_KEY` set.

MiniMax-M3.1-Flash uses adaptive thinking only; do not disable thinking or use effort `none`. Supported effort levels are `low`, `medium`, `high`, `xhigh`, and `max` (the API default). The OpenAI-compatible API uses `reasoning_effort`; the Anthropic-compatible API uses `output_config.effort`. Do not send `service_tier` or `reasoning_split=false` for Flash. CLI support for these controls depends on the installed client. MiniMax-M3 supports adaptive or disabled thinking and ignores effort.

The gateway catalog uses `openrouter/minimax/minimax-m3.1-flash:free` and `openrouter/minimax/minimax-m3`. These are gateway route IDs, not direct API IDs; gateway limits and pricing are governed by the gateway. API metadata does not establish subscription or Coding Plan access.

References: [models](https://platform.minimax.io/docs/guides/models-intro), [API compatibility](https://platform.minimax.io/docs/api-reference/text-anthropic-api).

---

## Provider precedence (v7.7.2)

When multiple sources specify a provider, Loki picks the first match in this order (highest wins):

| Priority | Source | Scope | Example |
|---|---|---|---|
| 1 | `loki start --provider NAME` | Per-invocation CLI flag | `loki start --provider opencode ./prd.md` |
| 2 | `.loki/state/provider` | Per-project saved value | `loki provider set claude` writes this file |
| 3 | `LOKI_PROVIDER` env var | Shell session default | `export LOKI_PROVIDER=opencode` |
| 4 | `claude` | Built-in default | (no config) |

**Important:** `loki status` reflects the **SAVED** value, not the env var. If you set `LOKI_PROVIDER=opencode` in your shell but ran `loki provider set claude` earlier in this project, `loki status` will show `claude`. To make a per-project choice persist, use `loki provider set NAME`.

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
- **Parallel Agents** - Concurrent subagents via the Task tool
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

## opencode

Model-agnostic route: opencode reaches many model providers (OpenRouter, any
OpenAI-compatible endpoint, local models) through its own registry.
Sequential execution, MCP supported.

### Installation

```bash
npm install -g opencode-ai
```

### OpenRouter

opencode reads `OPENROUTER_API_KEY` from the environment (or stores it with
`opencode auth login`, choosing OpenRouter). With the key set,
`opencode models openrouter` lists the OpenRouter models as
`openrouter/<vendor>/<model>`; without it opencode reports
`Provider not found: openrouter`. Loki passes the key through unchanged.

```bash
export OPENROUTER_API_KEY=sk-or-...
loki start ./prd.md --provider opencode --model openrouter/deepseek/deepseek-v3.2
```

### Invocation

```bash
opencode run --auto -m <provider/model> "<prompt>"
```

### Configuration

```bash
# Set as provider
export LOKI_PROVIDER=opencode

# Pick the model as provider/model (default comes from the catalog)
export LOKI_OPENCODE_MODEL=openrouter/deepseek/deepseek-v3.2

loki start ./prd.md --provider opencode
```

With `--provider opencode`, any `--model` value becomes opencode's `-m`. With
`--provider claude`, `--model openrouter/<id>` sets a Claude Code model route
(`LOKI_MODEL_ROUTE`) that points the claude CLI at OpenRouter instead.

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
#   claude    (installed, default)
#   opencode  (installed)
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
loki provider set opencode
```

### Per-Session Override

```bash
# Override for single session
loki start ./prd.md --provider opencode
```

---

## Feature Comparison

### Task Tool (Subagents)

**Claude:** Full support
```
Spawn parallel subagents for:
- Research tasks
- Code review
- Testing
- Documentation
```

**opencode:** Not supported
```
All tasks run sequentially in main context
```

### Parallel Execution

**Claude:** Git worktrees + parallel agents
```bash
export LOKI_PARALLEL_MODE=true
export LOKI_MAX_PARALLEL_SESSIONS=3
```

**opencode:** Sequential only
```
Each task completes before next begins
```

### Context Window

| Provider | Context | Effective Use |
|----------|---------|---------------|
| Claude | 200K | Large codebases |
| opencode | varies | Depends on backend model |

---

## Provider Selection Guide

### Use Claude When:

- Complex multi-file changes
- Need parallel execution
- Require code review quality
- Using MCP integrations
- Speed is important

### Use opencode When:

- You want an OpenRouter model or another non-Claude model
- You run local models (Ollama, LM Studio, llama.cpp)
- Sequential workflow acceptable

---

## Troubleshooting

### Provider Not Found

```bash
loki provider info opencode
# Error: Provider 'opencode' not installed

# Solution: Install the CLI
npm install -g opencode-ai
```

### Authentication Failed

```bash
# Re-authenticate
claude auth login
opencode auth login
```


### Wrong Provider Used

```bash
# Check current provider
loki provider show

# Reset to default
loki provider set claude
```
