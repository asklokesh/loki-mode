# Multi-Provider Support

Loki Mode v5.0.0 supports five AI providers for autonomous execution.

## Provider Comparison

> **CLI Flags Verified:** The autonomous mode flags have been verified against actual CLI help output:
> - Claude: `--dangerously-skip-permissions` (verified)
> - Codex: `--full-auto` (recommended, v0.98.0) or `exec --dangerously-bypass-approvals-and-sandbox` (legacy)
> - Gemini: `--approval-mode=yolo` (v0.27.3+) - Note: `-p` prompt flag is deprecated, using positional prompts

| Feature | Claude Code | OpenAI Codex | Gemini CLI | Cline CLI | Aider |
|---------|-------------|--------------|------------|-----------|-------|
| **Full Features** | Yes | No (Degraded) | No (Degraded) | Near-Full (Tier 2) | No (Degraded) |
| **Task Tool (Subagents)** | Yes | No | No | Yes (Subagents) | No |
| **Parallel Agents** | Yes (10+) | No | No | No | No |
| **MCP Integration** | Yes | Yes (basic) | No | Yes | No |
| **Context Window** | 200K | 400K | 1M | Varies by provider | Varies by provider |
| **Max Output Tokens** | 128K | 32K | 64K | Varies by provider | Varies by provider |
| **Model Tiers** | 3 (opus/sonnet/haiku) | 1 (effort param) | 1 (thinking param) | 1 (external) | 1 (external) |
| **Multi-Provider** | Claude only | OpenAI only | Gemini only | 12+ providers | 18+ providers |
| **Skill Directory** | ~/.claude/skills | None | None | None | None |

## Provider Selection

```bash
# Via environment variable
export LOKI_PROVIDER=claude  # or codex, gemini

# Via CLI flag
./autonomy/run.sh --provider codex ./prd.md
loki start --provider gemini ./prd.md
```

## Claude Code (Default, Full Features)

**Best for:** All use cases. Full autonomous capability.

**Capabilities:**
- Task tool for spawning subagents
- Parallel execution (10+ agents simultaneously)
- MCP server integration
- Three distinct models (opus/sonnet/haiku)
- 200K context window, 128K max output tokens

**Invocation:**
```bash
claude --dangerously-skip-permissions -p "$prompt"
```

**Model Selection:**
```python
Task(model="opus", ...)    # Planning tier
Task(model="sonnet", ...)  # Development tier
Task(model="haiku", ...)   # Fast tier (parallelize)
```

---

## OpenAI Codex CLI (Degraded Mode)

**Best for:** Teams standardized on OpenAI. Accepts feature tradeoffs.

**Limitations:**
- No Task tool (cannot spawn subagents)
- No parallel execution (sequential only)
- MCP support available but not yet integrated with Loki orchestration
- Single model with effort parameter
- 400K context window

**Invocation:**
```bash
# Recommended (v0.98.0+)
codex --full-auto "$prompt"

# Legacy (still supported)
codex exec --dangerously-bypass-approvals-and-sandbox "$prompt"
```

**Model Tiers via Effort (env var, not CLI flag):**

Note: Codex does not support `--effort` as a CLI flag. Reasoning effort must be configured via environment variable or config file.

```bash
# Set effort via environment
CODEX_MODEL_REASONING_EFFORT=high codex exec --dangerously-bypass-approvals-and-sandbox "$prompt"
```

| Tier | Effort | Use Case |
|------|--------|----------|
| planning | xhigh | Architecture, PRD analysis |
| development | high | Feature implementation, tests |
| fast | low | Simple fixes, docs |

---

## Google Gemini CLI (Degraded Mode)

**Best for:** Teams standardized on Google. Large context needs (1M tokens).

**Limitations:**
- No Task tool (cannot spawn subagents)
- No parallel execution (sequential only)
- No MCP integration
- Single model with thinking_level parameter
- 1M context window (largest)

**Invocation:**
```bash
# Note: -p flag is DEPRECATED. Using positional prompt.
gemini --approval-mode=yolo "$prompt"
```

**Model Tiers via Thinking Level (settings.json, not CLI flag):**

Note: Gemini CLI does not support `--thinking-level` as a CLI flag. Thinking mode must be configured in `~/.gemini/settings.json`.

```json
// ~/.gemini/settings.json
{
  "thinkingMode": "medium"  // high, medium, low
}
```

| Tier | Thinking | Use Case |
|------|----------|----------|
| planning | high | Architecture, PRD analysis |
| development | medium | Feature implementation, tests |
| fast | low | Simple fixes, docs |

---

## Cline CLI (Tier 2 - Near-Full, 12+ Providers)

**Best for:** Teams wanting Claude Code-like experience with any model provider.

**Tier 2 Capabilities (near-full):**
- Subagent support (Cline's native Subagents feature)
- MCP server integration
- Plan/Act modes (-p / -a flags)
- JSON structured output (--json flag)
- 12+ model providers via `cline auth`

**Limitations:**
- No Claude-style Task tool (uses native Subagents instead)
- No git worktree-style parallel execution
- Single model (configured externally)

**One-Time Setup:**
```bash
# Install Cline CLI
npm install -g cline@latest

# Configure provider and model (choose one):
cline auth -p openrouter -k sk-or-v1-your-key -m anthropic/claude-3.5-sonnet
cline auth -p ollama -m llama3
cline auth -p anthropic -k sk-ant-your-key
cline auth -p openai -k sk-your-key -m gpt-4o
```

**Usage with Loki:**
```bash
# Basic usage
loki start --provider cline ./prd.md

# With specific model
loki start --provider cline --cline-model deepseek/deepseek-chat ./prd.md

# With loki run
loki run 52 --provider cline --ship -d
```

**Invocation:**
```bash
cline -y "$prompt"               # Autonomous mode
cline -y -m model_name "$prompt" # With model override
```

---

## Aider (Tier 3 - Degraded, 18+ Providers)

**Best for:** Local models, custom providers, and teams wanting maximum provider flexibility.

**Strengths (compensate for degraded mode):**
- 18+ model providers (OpenRouter, Ollama, Together AI, GROQ, DeepSeek, Azure, Bedrock, etc.)
- `--architect` mode: planning model + editing model (SOTA quality)
- `--auto-lint --auto-test`: built-in verification loop
- `--map-tokens 2048`: tree-sitter repo map for codebase understanding
- Works with local models (Ollama, LM Studio) for free usage

**Limitations:**
- No subagent support
- Sequential execution only
- No Task tool or MCP
- Known issues with parallel instances

**One-Time Setup:**
```bash
# Install Aider
pip install aider-chat

# Configure provider via environment variables:

# OpenRouter
export OPENAI_API_BASE=https://openrouter.ai/api/v1
export OPENAI_API_KEY=sk-or-v1-your-key

# Ollama (local, free)
export OLLAMA_API_BASE=http://localhost:11434

# Together AI
export TOGETHER_API_KEY=your-key

# DeepSeek
export DEEPSEEK_API_KEY=your-key
```

**Usage with Loki:**
```bash
# Basic usage with OpenRouter
loki start --provider aider --aider-model anthropic/claude-3.5-sonnet ./prd.md

# Architect mode (dual model, SOTA quality)
loki start --provider aider --aider-model o1-preview \
    --aider-flags "--architect --editor-model deepseek/deepseek-chat" ./prd.md

# Local model (free, no API key needed)
loki start --provider aider --aider-model ollama/llama3 ./prd.md

# With auto-lint and auto-test
loki start --provider aider \
    --aider-flags "--auto-lint --auto-test --test-cmd pytest" ./prd.md
```

**Invocation:**
```bash
aider --message "$prompt" --yes-always --no-auto-commits --model model_name
```

**Environment Variables:**
| Variable | Description |
|----------|-------------|
| `LOKI_AIDER_MODEL` | Model to use (default: claude-3.7-sonnet) |
| `LOKI_AIDER_FLAGS` | Extra aider flags (e.g., --architect) |

---

## Degraded Mode Behavior

When running with Codex, Gemini, or Aider (Tier 3):

1. **RARV Cycle executes sequentially** - No parallel agents
2. **Task tool calls are skipped** - Main thread handles all work
3. **Model tier maps to provider configuration:**
   - Codex: `CODEX_MODEL_REASONING_EFFORT` env var (xhigh/high/medium/low)
   - Gemini: `~/.gemini/settings.json` thinkingMode (high/medium/low)
4. **Quality gates run sequentially** - No 3-reviewer parallel review
5. **Git worktree parallelism disabled** - `--parallel` flag has no effect

**Example output:**
```
[INFO] Provider: OpenAI Codex CLI (codex)
[WARN] Degraded mode: Parallel agents and Task tool not available
[INFO] Limitations:
[INFO]   - No Task tool subagent support - cannot spawn parallel agents
[INFO]   - Single model with effort parameter - no cheap tier for parallelization
```

---

## Provider Configuration Files

Provider configs are shell-sourceable files in `providers/`:

```
providers/
  claude.sh   # Full-featured provider (Tier 1)
  codex.sh    # Degraded mode, effort parameter (Tier 3)
  gemini.sh   # Degraded mode, thinking_level parameter (Tier 3)
  cline.sh    # Near-full mode, 12+ providers (Tier 2)
  aider.sh    # Degraded mode, 18+ providers (Tier 3)
  loader.sh   # Provider loader utility
```

**Key variables:**
```bash
PROVIDER_NAME="claude"
PROVIDER_HAS_SUBAGENTS=true
PROVIDER_HAS_PARALLEL=true
PROVIDER_HAS_TASK_TOOL=true
PROVIDER_DEGRADED=false
```

---

## Choosing a Provider

| If you need... | Choose |
|----------------|--------|
| Full autonomous capability | Claude |
| Parallel agent execution | Claude |
| MCP server integration | Claude (full), Cline, or Codex (basic) |
| Subagents without Claude subscription | Cline |
| OpenAI ecosystem compatibility | Codex |
| Largest context window (1M) | Gemini |
| Maximum provider flexibility (18+) | Aider |
| Local models (Ollama, free) | Aider or Cline |
| Architect mode (dual model) | Aider |
| Sequential-only is acceptable | Codex, Gemini, or Aider |
