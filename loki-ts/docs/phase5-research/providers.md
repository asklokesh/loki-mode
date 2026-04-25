# Phase 5 Research: Provider System Architecture

**Status**: Read-only deliverable for Loki Mode bash-to-Bun migration.  
**Scope**: Inventory and analysis of /Users/lokesh/git/loki-mode/providers/  
**Date**: April 25, 2026

## 1. Provider Loader (providers/loader.sh)

### Exposed Interface

The loader exposes the following functions to sourcing scripts:

- `load_provider(provider_name)`: Validates and sources a provider config file (line 25)
- `validate_provider(provider_name)`: Checks provider name against SUPPORTED_PROVIDERS array (line 14)
- `validate_provider_config()`: Verifies required variables are set after sourcing (line 65)
- `check_provider_installed(provider_name)`: Tests if provider CLI is available (line 105)
- `get_installed_providers()`: Returns array of all installed providers (line 118)
- `print_provider_info()`: Human-readable provider details (line 129)
- `print_capability_matrix()`: Tabular comparison of all providers (line 149)
- `auto_detect_provider()`: Selects highest-priority installed provider (line 176)

### Environment Variables Set/Required

Upon successful load, each provider defines these PROVIDER_* variables (validated at line 66-99):

**Core Identity**:
- `PROVIDER_NAME`: Machine name (e.g., "claude")
- `PROVIDER_DISPLAY_NAME`: Human-readable name (e.g., "Claude Code")
- `PROVIDER_CLI`: CLI binary name (e.g., "claude")

**Invocation**:
- `PROVIDER_AUTONOMOUS_FLAG`: CLI flag for autonomous mode (line 70)
- `PROVIDER_PROMPT_FLAG`: Flag for prompt input (e.g., "-p" or "" for positional)
- `PROVIDER_PROMPT_POSITIONAL`: Boolean, true if prompt is positional arg

**Capabilities** (lines 40-48, 140-145):
- `PROVIDER_HAS_SUBAGENTS`: Boolean, supports spawn_agent()
- `PROVIDER_HAS_PARALLEL`: Boolean, allows concurrent execution
- `PROVIDER_HAS_TASK_TOOL`: Boolean, has Task tool for agents
- `PROVIDER_HAS_MCP`: Boolean, MCP server integration
- `PROVIDER_MAX_PARALLEL`: Integer, max concurrent workers
- `PROVIDER_SKILL_DIR`: Path to skills directory (e.g., ~/.claude/skills)
- `PROVIDER_SKILL_FORMAT`: Skill format (markdown, yaml, none)

**Models**:
- `PROVIDER_MODEL_PLANNING`: Model for architecture/reasoning (e.g., "opus")
- `PROVIDER_MODEL_DEVELOPMENT`: Model for implementation (e.g., "sonnet")
- `PROVIDER_MODEL_FAST`: Model for simple tasks (e.g., "haiku")
- `PROVIDER_CONTEXT_WINDOW`: Token limit (e.g., 1000000)
- `PROVIDER_MAX_OUTPUT_TOKENS`: Output cap (e.g., 128000)

**Degradation** (lines 133-138):
- `PROVIDER_DEGRADED`: Boolean, true if missing features
- `PROVIDER_DEGRADED_REASONS`: Array of limitation strings

### Security & Validation

- **Path traversal prevention** (line 28): Provider name validated against whitelist before sourcing
- **Syntax validation** (line 43): `bash -n` checks syntax before execution
- **Variable validation** (line 56): Confirms all required vars are set and non-empty
- **Default provider** (line 11): Falls back to "claude" if not specified

---

## 2. Provider Implementations

### Claude (providers/claude.sh, lines 1-200)

**Functions Exported**:
- `provider_detect()` (line 103): `command -v claude`
- `provider_version()` (line 108): `claude --version`
- `provider_invoke(prompt, ...)` (line 113): Main invocation
- `provider_invoke_with_tier(tier, prompt, ...)` (line 192): Tier-based model selection
- `provider_get_tier_param(tier)` (line 121): Map tier to model name
- `resolve_model_for_tier(tier)` (line 148): Tier-to-model resolution with maxTier cap

**CLI Command**: `claude`  
**Autonomous Flag**: `--dangerously-skip-permissions` (line 31)  
**Prompt Delivery**: `-p <prompt>` flag (line 32)

**Environment Required**:
- None mandatory (API key via Claude Code auth)
- Optional: `LOKI_ALLOW_HAIKU`, `LOKI_CLAUDE_MODEL_PLANNING/DEVELOPMENT/FAST`, `LOKI_MAX_TIER`

**Model Configuration** (lines 55-67):
- **Planning**: `CLAUDE_DEFAULT_PLANNING="opus"` (1M context, adaptive thinking)
- **Development**: `CLAUDE_DEFAULT_DEVELOPMENT="opus"` (upgraded from sonnet for quality)
- **Fast**: `CLAUDE_DEFAULT_FAST="sonnet"` (was haiku, now sonnet for parallelization safety)
- **Haiku mode**: Disabled by default; enable with `LOKI_ALLOW_HAIKU=true`
- **Resolution order**: `LOKI_CLAUDE_MODEL_* > LOKI_MODEL_* > default`

**Degradation Status**: `PROVIDER_DEGRADED=false` (line 99) — Full tier 1 support

**Capabilities**:
- Subagents: true
- Parallel execution: true (max 10, line 44)
- Task tool: true (with model param, line 42)
- MCP: true
- Skills: markdown format in ~/.claude/skills (line 36)

**Unique Features**:
- 1M context window (line 80) for deep memory retrieval
- Adaptive thinking with xhigh effort default (line 86)
- Cost tracking per tier: Opus ($0.015/$0.075), Sonnet ($0.003/$0.015), Haiku ($0.00025/$0.00125)

---

### Cline (providers/cline.sh, lines 1-139)

**Functions Exported**:
- `provider_detect()` (line 95): `command -v cline`
- `provider_version()` (line 100): `cline --version`
- `provider_invoke(prompt, ...)` (line 108): Main invocation
- `provider_invoke_with_tier(tier, prompt, ...)` (line 133): Tier param (returns model only)
- `provider_get_tier_param(tier)` (line 118): Tier to model name
- `resolve_model_for_tier(tier)` (line 126): Single model, ignores tier

**CLI Command**: `cline`  
**Autonomous Flag**: `-y` (YOLO mode, line 33)  
**Prompt Delivery**: Positional argument (line 35)

**Environment Required**:
- `LOKI_CLINE_MODEL` (optional, defaults to catalog or "claude-opus-4-7")
- Underlying provider credentials (OpenAI, Anthropic, etc. per model)

**Model Configuration** (lines 56-70):
- Single model, dynamically loaded from `providers/models.sh::loki_latest_model cline development`
- All three tiers map to same model (line 126-128)
- No tier-specific reasoning effort available
- maxTier ignored (line 125)

**Degradation Status**: `PROVIDER_DEGRADED=false` (line 91) — Tier 2 (near-full)

**Capabilities**:
- Subagents: true
- Parallel execution: false (max 1, line 48)
- Task tool: false (line 46)
- MCP: true (line 47)
- Skills: none (line 40)

**Unique Features**:
- Multi-provider gateway (Claude, Codex, Gemini, Bedrock, etc.)
- 200K context window (conservative, line 77)
- No model parameter tuning (cost ~$0.003/$0.015 per tier)
- Word-splitting safety on model names (line 106, BUG-PROV-009 fix)

---

### Codex (providers/codex.sh, lines 1-190)

**Functions Exported**:
- `provider_detect()` (line 107): `command -v codex`
- `provider_version()` (line 112): `codex --version`
- `provider_invoke(prompt, ...)` (line 119): Main invocation
- `provider_invoke_with_tier(tier, prompt, ...)` (line 180): Tier to effort level
- `provider_get_tier_param(tier)` (line 126): Map tier to effort (xhigh/high/low)
- `resolve_model_for_tier(tier)` (line 142): Returns effort level, not model (BUG-PROV-012 note)

**CLI Command**: `codex`  
**Autonomous Flag**: `exec --full-auto` (line 35) with sandbox workspace-write  
**Prompt Delivery**: Positional after exec subcommand (line 35-37)

**Environment Required**:
- `OPENAI_API_KEY` or OPENAI auth
- Optional: `LOKI_CODEX_REASONING_EFFORT` or `CODEX_MODEL_REASONING_EFFORT`

**Model Configuration** (lines 50-75):
- Single model: `gpt-5.3-codex` (line 53)
- Effort levels control reasoning time: xhigh/high/low (lines 78-80)
- Model validation filters generic LOKI_MODEL_* for gpt-/o1-/o3- prefixes (line 55-70)
- All tiers use same model, effort differentiates (line 73-75)

**Degradation Status**: `PROVIDER_DEGRADED=true` (line 100) — Tier 3

**Degradation Reasons** (lines 101-104):
- No Task tool subagent support (sequential only)
- Single model with effort parameter (no cheap parallelization tier)

**Capabilities**:
- Subagents: false
- Parallel execution: false (max 1, line 48)
- Task tool: false (line 46)
- MCP: true (line 47)
- Skills: markdown format in ~/.agents/skills (line 40-41)

**Unique Features**:
- Effort mapped to maxTier ceiling: haiku→low, sonnet→high, opus→xhigh (line 165)
- 400K context window (line 87)
- Cost stable across tiers: $0.010/$0.030 (line 92-97)
- BUG-PROV-002 fix: Validates model names to prevent Claude/Gemini names leaking in

---

### Gemini (providers/gemini.sh, lines 1-343)

**Functions Exported**:
- `provider_detect()` (line 179): `command -v gemini`
- `provider_version()` (line 184): `gemini --version`
- `provider_invoke(prompt, ...)` (line 195): Main invocation with rate-limit fallback
- `provider_invoke_with_tier(tier, prompt, ...)` (line 300): Tier to model with fallback
- `provider_get_tier_param(tier)` (line 243): Map tier to thinking level (high/medium/low)
- `resolve_model_for_tier(tier)` (line 256): Tier to model (pro/flash)

**CLI Command**: `gemini`  
**Autonomous Flag**: `--approval-mode=yolo` (line 33)  
**Prompt Delivery**: Positional argument (line 36, -p flag deprecated per line 34)

**Environment Required**:
- `GOOGLE_API_KEY` or `GEMINI_API_KEY` or gcloud ADC
- Optional: `LOKI_GEMINI_MODEL_PLANNING/DEVELOPMENT/FAST`, `LOKI_GEMINI_RPM`, `LOKI_GEMINI_API_KEYS` (key rotation)
- Optional: `LOKI_MAX_TIER`

**Model Configuration** (lines 50-77):
- **Planning**: `gemini-3-pro-preview` (high thinking, line 54)
- **Development**: `gemini-3-pro-preview` (medium thinking)
- **Fast**: `gemini-3-flash-preview` (low thinking, fallback on rate limit)
- Model validation (line 61-72) filters for gemini- or models/gemini- prefixes
- Thinking levels control reasoning depth (lines 91-93)

**Degradation Status**: `PROVIDER_DEGRADED=true` (line 115) — Tier 3

**Degradation Reasons** (lines 116-121):
- No Task tool subagent support (sequential only)
- Single model with thinking_level parameter (no cheap tier for parallelization)
- No native skills system (must embed SKILL.md in prompt)
- No MCP server integration

**Capabilities**:
- Subagents: false
- Parallel execution: false (max 1, line 48)
- Task tool: false (line 46)
- MCP: false (line 47)
- Skills: none (line 41)

**Unique Features**:
- **Rate-limit fallback** (line 231-239): Falls back to flash model on 429/quota errors
- **API key rotation** (line 145-176, BUG-PROV-003 fix): Rotates through LOKI_GEMINI_API_KEYS comma-separated list on 401/403
- **Streaming capture** (line 212-217, BUG-PROV-010 fix): Uses `tee` to stream output while capturing for error detection
- 1M context window (line 100, same as Claude)
- Conservative rate limit: 15 RPM free tier default (line 104, override with LOKI_GEMINI_RPM)
- Cost cheap: $0.00125/$0.005 per tier (line 107-112)

---

### Aider (providers/aider.sh, lines 1-145)

**Functions Exported**:
- `provider_detect()` (line 97): `command -v aider`
- `provider_version()` (line 102): `aider --version`
- `provider_invoke(prompt, ...)` (line 110): Main invocation
- `provider_invoke_with_tier(tier, prompt, ...)` (line 139): Tier param (returns model only)
- `provider_get_tier_param(tier)` (line 124): Tier to model name
- `resolve_model_for_tier(tier)` (line 132): Single model, ignores tier

**CLI Command**: `aider`  
**Autonomous Flag**: `--yes-always` (line 33)  
**Prompt Delivery**: `--message <prompt>` flag (line 34)

**Environment Required**:
- Provider-specific: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc. per underlying model
- Optional: `LOKI_AIDER_MODEL`, `LOKI_AIDER_FLAGS`

**Model Configuration** (lines 49-69):
- Single model from catalog: `loki_latest_model aider development` (line 61)
- All tiers map to same model (line 132-134)
- No tier-specific differentiation
- maxTier ignored

**Degradation Status**: `PROVIDER_DEGRADED=true` (line 89) — Tier 3

**Degradation Reasons** (lines 90-94):
- No subagent support (sequential only)
- No Task tool
- No MCP server integration

**Capabilities**:
- Subagents: false
- Parallel execution: false (max 1, line 47)
- Task tool: false (line 45)
- MCP: false (line 46)
- Skills: none (line 40)

**Unique Features**:
- 18+ provider gateway (litellm router)
- 200K context window (conservative, line 76)
- Git-aware (--no-auto-commits flag at line 118 because Loki manages VCS)
- Extra flags support (line 114, LOKI_AIDER_FLAGS)
- Cost ~$0.003/$0.015 per tier (like Cline)

---

## 3. Provider Invocation Pattern

### Sourcing Locations

**autonomy/run.sh**:
- Line 7577: `source "$provider_dir/$provider.sh"` — Failover provider switch (load new config mid-run)
- Line 7639: `source "$provider_dir/$primary.sh"` — Recovery to primary provider

**autonomy/loki** (CLI):
- Line 2863-2939: `bash -c "source '$provider_file'; echo \$PROVIDER_*"` — Query model/effort/thinking params
- Line 4595: `source "$issue_providers_script"` — Issue-specific provider config
- Line 10799: `source "$script_dir/../providers/loader.sh"` — Health check initialization

**Pattern Summary**:
1. Scripts source **providers/loader.sh** for validation utilities
2. Direct source of provider configs (claude.sh, codex.sh, etc.) only when:
   - Failover requires provider switch (line 7577)
   - Health recovery to primary (line 7639)
   - CLI needs to query provider metadata (line 2863)
3. **No direct bash invocation** in loop—provider_invoke() functions called via shell metacalls

### Typical Invocation Flow

```bash
# Query phase: Load provider and get model tiers
source providers/claude.sh
planning_model=$(echo $PROVIDER_MODEL_PLANNING)
dev_model=$(echo $PROVIDER_MODEL_DEVELOPMENT)

# Execution phase: Use provider function
provider_invoke "Build feature X"

# Failover phase: Switch provider mid-run
source providers/codex.sh
# Now PROVIDER_NAME=codex, etc.
provider_invoke "Continue task"
```

---

## 4. Provider-Specific Behavior Comparison

### Tier Support & Model Selection

| Aspect | Claude | Cline | Codex | Gemini | Aider |
|--------|--------|-------|-------|--------|-------|
| **Tiers** | 3 (opus/sonnet/haiku*) | 1 (single model) | 1 (single + effort) | 2 (pro/flash) | 1 (single) |
| **Planning Model** | opus | claude-opus-4-7 | gpt-5.3-codex | gemini-3-pro | claude-opus-4-7 |
| **Dev Model** | opus | (same) | (same) | gemini-3-pro | (same) |
| **Fast Model** | sonnet | (same) | (same) | gemini-3-flash | (same) |
| **Context Window** | 1M | 200K | 400K | 1M | 200K |

*Haiku disabled by default (LOKI_ALLOW_HAIKU)

### Feature Matrix

| Feature | Claude | Cline | Codex | Gemini | Aider |
|---------|--------|-------|-------|--------|-------|
| **Tier 1 (Full)** | YES | - | - | - | - |
| **Tier 2 (Near-Full)** | - | YES | - | - | - |
| **Tier 3 (Degraded)** | - | - | YES | YES | YES |
| **Subagents** | YES | YES | NO | NO | NO |
| **Parallel Execution** | YES | NO | NO | NO | NO |
| **Task Tool** | YES | NO | NO | NO | NO |
| **MCP Integration** | YES | YES | NO | NO | NO |
| **Skills System** | YES (~/.claude/skills) | NO | YES (~/.agents/skills) | NO | NO |
| **Context Window** | 1M | 200K | 400K | 1M | 200K |

### Degradation Logic

**Claude (Tier 1: Full Features)**:
- No degradation. All features available. Default provider.
- Auto-detect priority #1 (line 177, loader.sh).

**Cline (Tier 2: Near-Full)**:
- Has subagents and MCP (not degraded per line 91, cline.sh).
- Missing: Task tool (async agents), parallel execution.
- Auto-detect priority #2 (line 177).
- Best fallback when Claude unavailable.

**Codex, Gemini, Aider (Tier 3: Degraded)**:
- Sequential-only execution (max 1 parallel worker).
- No Task tool subagents (cannot spawn children).
- Model/effort/thinking differences don't compensate for lack of parallelization.
- Codex: Skill system works. Effort-based reasoning control.
- Gemini: Rate-limit fallback + API key rotation. No skills. Cheap ($0.00125).
- Aider: Cheapest. Multi-provider gateway. Git-aware. No skills.
- Auto-detect priority #3 (claude cline codex gemini aider).

---

## 5. Fallback & Degradation in loader.sh

### Validation Fallback

**load_provider() failure chain** (lines 25-62):

1. **Invalid provider name** (line 29): Return error, list supported providers
2. **Config file missing** (line 37): Return error, path shown
3. **Syntax error** (line 43): Return error, file path shown
4. **Variable validation failure** (line 56): Return error, name of missing var shown

All errors to stderr; sourcing script must handle return code.

### Capability Fallback at Runtime

Loader does **NOT** implement fallback logic. Instead:

1. **Invocation layer** (autonomy/run.sh, line 7560-7611): Checks provider health, swaps on failure
2. **Provider layer** (e.g., gemini.sh line 231-239): Some providers catch errors and retry with fallback model
   - Gemini: Rate-limit → fallback to flash (line 235)
   - Gemini: Auth error → rotate API key (line 221)

### Degradation Signals

Scripts can check these to adapt behavior:

```bash
# After source provider.sh:
if [ "$PROVIDER_DEGRADED" = "true" ]; then
    echo "Warning: Using degraded provider"
    for reason in "${PROVIDER_DEGRADED_REASONS[@]}"; do
        echo "  - $reason"
    done
    # Disable parallelization, etc.
fi
```

**Default handling** (autonomy/run.sh, line 7560-7611):
- If provider fails (rate limit, auth), try next provider in chain
- Chain order: claude > cline > codex > gemini (no aider by default)
- On recovery, switch back to primary

---

## 6. TypeScript Module Structure for Phase 5 Migration

### TS Interface Design

Proposed structure in `loki-ts/src/providers/`:

```typescript
// providers/base.ts
export interface ProviderConfig {
  // Identity (1 export set per provider)
  name: ProviderName;  // 'claude' | 'cline' | 'codex' | 'gemini' | 'aider'
  displayName: string;
  cli: string;

  // Invocation (describes how to call the CLI)
  autonomousFlag: string;  // e.g., '--dangerously-skip-permissions'
  promptFlag: string | null;  // e.g., '-p' or null for positional
  promptPositional: boolean;

  // Capabilities (boolean flags)
  hasSubagents: boolean;
  hasParallel: boolean;
  hasTaskTool: boolean;
  hasMcp: boolean;
  maxParallel: number;

  // Degradation
  isDegraded: boolean;
  degradedReasons: string[];

  // Models (resolve at runtime)
  models: {
    planning: string;
    development: string;
    fast: string;
  };

  // Limits
  contextWindow: number;
  maxOutputTokens: number;
  rateLimitRpm: number;

  // Skills
  skillDir: string | null;
  skillFormat: 'markdown' | 'yaml' | 'none';
}

// providers/types.ts
export interface InvocationOptions {
  prompt: string;
  tier?: 'planning' | 'development' | 'fast';
  model?: string;  // Override default
  effort?: string;  // Codex reasoning level
  thinking?: string;  // Gemini thinking level
  args?: string[];
}

export interface InvocationResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}

// providers/loader.ts
export class ProviderLoader {
  constructor(providersDir: string) {}

  loadProvider(name: ProviderName): Promise<ProviderConfig>;
  validateProvider(name: string): boolean;
  validateConfig(config: ProviderConfig): boolean;
  detectInstalled(name: ProviderName): Promise<boolean>;
  getInstalledProviders(): Promise<ProviderName[]>;
  autoDetectProvider(): Promise<ProviderName | null>;

  // Capability queries
  canParallelize(name: ProviderName): Promise<boolean>;
  canSpawnSubagents(name: ProviderName): Promise<boolean>;
}

// providers/provider.ts (base class)
export abstract class Provider {
  config: ProviderConfig;

  abstract detect(): Promise<boolean>;
  abstract version(): Promise<string>;
  abstract invoke(options: InvocationOptions): Promise<InvocationResult>;
  abstract invokeTiered(
    tier: 'planning' | 'development' | 'fast',
    prompt: string,
    args?: string[]
  ): Promise<InvocationResult>;

  getTierModel(tier: string): Promise<string>;
  getCapabilityMatrix(): Promise<CapabilityMatrix>;
}

// providers/implementations/
export class ClaudeProvider extends Provider { /* ... */ }
export class ClineProvider extends Provider { /* ... */ }
export class CodexProvider extends Provider { /* ... */ }
export class GeminiProvider extends Provider { /* ... */ }
export class AiderProvider extends Provider { /* ... */ }

// providers/index.ts (public API)
export async function createProvider(
  name: ProviderName,
  providersDir?: string
): Promise<Provider>;

export async function getDefaultProvider(): Promise<Provider>;

export interface ProviderRegistry {
  [key: ProviderName]: Provider;
}

export async function loadAllProviders(
  providersDir: string
): Promise<ProviderRegistry>;
```

### Key Design Decisions

1. **Config as data, behavior in methods**: Unlike bash (where sourcing sets vars directly), TS separates config objects from invocation logic
2. **Async/await**: Provider.invoke() returns Promise for streaming, timeout handling
3. **Tier resolution**: buildable at load time (unlike bash dynamic resolution) or at call time for maxTier support
4. **Error handling**: Typed exceptions (ProviderNotFound, ConfigInvalid, CliNotInstalled, etc.)
5. **Rate-limit fallback**: Move from provider-level (gemini.sh) to provider method or orchestration layer
6. **Model catalog**: Load from model_catalog.json (line 18, models.sh) at startup
7. **Env override precedence**: `LOKI_<PROVIDER>_MODEL_<TIER> > LOKI_<PROVIDER>_MODEL > catalog`

### Integration Points

- **autonomy/run.sh → orchestration.ts**: Provider invocation during RARV loop
- **autonomy/loki → cli.ts**: Provider selection, health checks, failover
- **memory/engine.py → memory-service.ts**: Query provider capabilities for task budgeting
- **events/bus.ts**: Emit provider_failover, provider_switch events
- **dashboard/server.py → dashboard.ts**: Provider status endpoints

---

## Summary

The provider system achieves multi-LLM support via shell sourcing of provider configs. Each provider defines a consistent interface (provider_detect, provider_invoke, etc.) and metadata (capability flags, models, context limits). Claude is Tier 1 (full features); Cline is Tier 2 (near-full with subagents but no parallelization); Codex/Gemini/Aider are Tier 3 (sequential-only with model/effort/thinking variants). The loader validates and enforces required variables before sourcing. Fallback and degradation happen at the invocation layer (run.sh failover chain), not at the provider level (except Gemini's rate-limit/auth rotation). Phase 5 TS migration should preserve this config-as-data model while leveraging async/await and typed exceptions for cleaner error handling.

**Total LOC**: providers/loader.sh (186), claude.sh (200), cline.sh (139), codex.sh (190), gemini.sh (343), aider.sh (145) = **1,203 LOC** of provider system.

