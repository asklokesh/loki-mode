# Multi-Provider Support

Loki Mode v5.0.0 supports three AI providers for autonomous execution.

## Provider Comparison

> **CLI Flags Verified:** The autonomous mode flags have been verified against actual CLI help output:
> - Claude: `--dangerously-skip-permissions` (verified)
> - Codex: `--full-auto` (recommended, v0.98.0) or `exec --dangerously-bypass-approvals-and-sandbox` (legacy)
> - Gemini: `--approval-mode=yolo` (v0.25.2+) - Note: `-p` prompt flag is deprecated, using positional prompts

| Feature | Claude Code | OpenAI Codex | Gemini CLI |
|---------|-------------|--------------|------------|
| **Full Features** | Yes | No (Degraded) | No (Degraded) |
| **Task Tool (Subagents)** | Yes | No | No |
| **Parallel Agents** | Yes (10+) | No | No |
| **MCP Integration** | Yes | Yes (basic) | No |
| **Context Window** | 200K | 400K | 1M |
| **Max Output Tokens** | 128K | 32K | 64K |
| **Model Tiers** | 3 (opus/sonnet/haiku) | 1 (effort param) | 1 (thinking param) |
| **Skill Directory** | ~/.claude/skills | None | None |

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

## Degraded Mode Behavior

When running with Codex or Gemini:

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
  claude.sh   # Full-featured provider
  codex.sh    # Degraded mode, effort parameter
  gemini.sh   # Degraded mode, thinking_level parameter
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
| MCP server integration | Claude (full) or Codex (basic) |
| OpenAI ecosystem compatibility | Codex |
| Largest context window (1M) | Gemini |
| Sequential-only is acceptable | Codex or Gemini |
