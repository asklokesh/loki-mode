# Multi-Provider Support

Loki Mode supports five AI providers for autonomous execution.

## Provider Comparison

> **CLI Flags Verified:** The autonomous mode flags have been verified against actual CLI help output:
> - Claude: `--dangerously-skip-permissions` (verified)
> - Codex: `exec --sandbox workspace-write --skip-git-repo-check` (the harness invocation; --skip-git-repo-check required on fresh non-git dirs; --full-auto deprecated in codex 0.125+, workspace-write is the documented replacement) or `exec --dangerously-bypass-approvals-and-sandbox` (legacy)

| Feature | Claude Code | OpenAI Codex | Cline CLI | Aider | opencode |
|---------|-------------|--------------|-----------|-------|----------|
| **Full Features** | Yes | No (Degraded) | Near-Full (Tier 2) | No (Degraded) | Model-agnostic |
| **Task Tool (Subagents)** | Yes | No | Yes (Subagents) | No | No |
| **Parallel Agents** | Yes (10+) | No | No | No | No |
| **MCP Integration** | Yes | Yes (basic) | Yes | No | Yes |
| **Context Window** | 200K | 400K | Varies by provider | Varies by provider | Varies by provider |
| **Max Output Tokens** | 128K | 32K | Varies by provider | Varies by provider | Varies by provider |
| **Model Tiers** | 3 (opus/sonnet/haiku) | 1 (effort param) | 1 (external) | 1 (external) | 1 (external) |
| **Multi-Provider** | Claude only | OpenAI only | 12+ providers | 18+ providers | 75+ providers + custom endpoints |
| **Skill Directory** | ~/.claude/skills | None | None | None | ~/.config/opencode |

## Provider Selection

**You do not have to choose one.** Since v8.64.0, leaving `LOKI_PROVIDER`
unset auto-detects the first installed provider in this priority order:

```
claude > cline > codex > aider > opencode
```

```
[loki] provider: codex (auto-detected)
```

The order lives in `auto_detect_provider()` (`providers/loader.sh`), which is
the single authority. Any other list that names providers must agree with it --
a second list that had drifted was blocking opencode-only machines from
starting a build at all until v8.76.0.

Set it explicitly only when you want a provider other than the highest-priority
installed one. An explicit choice always wins, and is never silently
substituted: naming a provider that is not installed fails immediately with its
install command rather than quietly running a different model (v8.66.0).

```bash
# Via environment variable
export LOKI_PROVIDER=claude  # or cline, codex, aider, opencode

# Via CLI flag
./autonomy/run.sh --provider codex ./prd.md
loki start --provider cline ./prd.md
```

`loki doctor` prints which providers are installed and which one would be
auto-selected.

## Any Model, Any Provider (ANTHROPIC_BASE_URL)

Independent of the five CLI providers below. Loki speaks the Anthropic Messages
API, so ANY endpoint that implements it works: OpenRouter, Ollama, LiteLLM,
vLLM, or a self-hosted gateway. Nothing needs installing.

```bash
export ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1   # or http://localhost:11434/v1
export ANTHROPIC_API_KEY=...                             # omit for a keyless local Ollama
export LOKI_MODEL_OVERRIDE=<exact model id from your provider>
loki start prd.md
```

**BOTH variables are required.** The override at `providers/claude.sh:520` fires
only when `ANTHROPIC_BASE_URL` AND `LOKI_MODEL_OVERRIDE` are both set. With only
the base URL, Loki keeps resolving the tier aliases `opus` / `sonnet` / `haiku`,
which only Anthropic serves -- most providers reject them and the run dies at the
first model call. (A proxy that maps the aliases, such as LiteLLM, is the
exception.) `loki doctor` warns on exactly this condition.

Implementation, byte-mirrored across both routes -- edit BOTH or the parity
fixtures diverge:

| Route | Site |
|---|---|
| bash | `providers/claude.sh:520`, `autonomy/run.sh:693` |
| Bun  | `loki-ts/src/runner/providers.ts:328` |
| doctor | `loki-ts/src/commands/doctor.ts:652` |

`ANTHROPIC_BASE_URL` is passed through unchanged; Loki never rewrites it.

**No model IDs are listed here deliberately.** Alt-provider catalogues change
weekly, and a stale ID in documentation becomes a runtime failure for the user.
Read the exact string from the provider (`ollama list`, OpenRouter's model page,
your gateway's config). For the same reason `LOKI_MODEL_OVERRIDE` is NOT
validated against an allowlist -- any string the provider accepts is passed
straight through.

Quality gates, the completion council, and the Evidence Receipt are all
model-agnostic: they assert on the artifact that was built, not on which model
built it. A cheaper or local model gets the same verification as Opus.

### Keeping the model catalog current

`providers/model_catalog.json` is hand-maintained and carries an `updated` date.
Models ship constantly, so the catalog rots. `loki doctor` reports its age in a
`Model catalog:` section and warns once it passes 90 days:

```
WARN  Last updated 2026-01-02 (210 days ago) -- may be missing newer models
      Refresh: python3 tools/probe-model-catalog.py
```

The warning is **advisory only**. It never changes an exit code and never fails
a build (`tests/test-model-catalog-staleness.sh` asserts exactly that). It also
makes no network call: doctor reads the local file's `updated` field and nothing
else, so air-gapped operation (`docs/air-gapped.md`) is unaffected.

To refresh:

```bash
python3 tools/probe-model-catalog.py     # report new model IDs found in provider docs
```

The probe reads public provider documentation and reports model IDs that are not
yet in the catalog. **It never rewrites the catalog.** You edit
`providers/model_catalog.json` by hand -- bump the relevant `latest_<tier>` and
add the model to `models[]` -- then set `updated` to today. Model adoption is a
human decision: cost, capability, and behavioural changes all need a person to
weigh them, and a model ID that does not exist would break every run that
selects it. Being stale is recoverable; a fabricated model ID is not.

The probe is also wired to a weekly CI job (`.github/workflows/model-catalog-probe.yml`)
that opens a draft PR with its findings. That job is CI-only -- it is not on any
runtime path.

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

## OpenAI Codex CLI (Experimental, Degraded Mode)

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
codex exec --sandbox workspace-write --skip-git-repo-check "$prompt"

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

# With loki run (DEPRECATED -- still works; prefer `loki start`)
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
| `LOKI_AIDER_MODEL` | Model to use. Default comes from `providers/model_catalog.json` (`aider.latest_development`), not a hardcoded string. The global `LOKI_MODEL_*` tier vars do NOT apply to aider. |
| `LOKI_AIDER_FLAGS` | Extra aider flags (e.g., --architect) |

---

## opencode (Model-Agnostic, 75+ Providers)

**Best for:** OpenRouter, local models, and custom OpenAI-compatible endpoints without maintaining a fixed Loki vendor catalog.

**Capabilities:**
- 75+ registered model providers plus custom endpoints
- Local-model support through Ollama, LM Studio, and llama.cpp
- MCP server support
- Autonomous `opencode run --auto` execution

**Limitations:**
- Sequential Loki execution only
- No Claude-style Task tool or Loki parallel-agent worktrees

**Setup and selection:**
```bash
npm install -g opencode-ai
opencode auth login
loki provider set opencode
loki start ./prd.md
```

Set `LOKI_OPENCODE_MODEL` to an exact `provider/model` identity when the configured opencode default is not desired.

---

## Degraded Mode Behavior

When running with Codex or Aider (Tier 3):

1. **RARV Cycle executes sequentially** - No parallel agents
2. **Task tool calls are skipped** - Main thread handles all work
3. **Model tier maps to provider configuration:**
   - Codex: `CODEX_MODEL_REASONING_EFFORT` env var (xhigh/high/medium/low)
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
  cline.sh    # Near-full mode, 12+ providers (Tier 2)
  aider.sh    # Degraded mode, 18+ providers (Tier 3)
  opencode.sh # Model-agnostic mode, 75+ providers and custom endpoints
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
| Maximum provider flexibility (18+) | Aider |
| Provider registry or custom endpoint | opencode |
| Local models (Ollama, free) | opencode, Aider, or Cline |
| Architect mode (dual model) | Aider |
| Sequential-only is acceptable | Codex or Aider |
