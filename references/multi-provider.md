# Multi-Provider Architecture Reference

> **Status:** Production | **Provider list and model config verified against source at v9.8.1**
>
> Values below are illustrative. `providers/*.sh` is the authority; prefer
> reading it over trusting a literal copied into this document.

Loki Mode supports five AI CLI providers with a unified abstraction layer. This document provides detailed technical reference for the multi-provider system.

---

## Provider Overview

Source of truth: `SUPPORTED_PROVIDERS` in `providers/loader.sh:8`.

| Provider | CLI | Status | Features |
|----------|-----|--------|----------|
| **Claude Code** | `claude` | Full | Subagents, Parallel, Task Tool, MCP |
| **OpenAI Codex** | `codex` | Degraded | Sequential, Effort Parameter, MCP (basic) |
| **Cline CLI** | `cline` | Near-Full (Tier 2) | Subagents, MCP, 12+ providers |
| **Aider** | `aider` | Degraded | Sequential, 18+ providers |
| **opencode** | `opencode` | Sequential | MCP, 75+ providers, model-agnostic |

When `LOKI_PROVIDER` is unset, providers auto-detect in priority order:
`claude > cline > codex > aider > opencode`. An explicit choice always wins and
is never silently substituted.

Gemini was removed as a provider.

---

## Provider Configuration Files

Located in `providers/` directory:

```
providers/
  claude.sh   # Full-featured provider
  codex.sh    # Degraded mode, effort parameter
  cline.sh    # Near-full mode, 12+ providers (Tier 2)
  aider.sh    # Degraded mode, 18+ providers
  opencode.sh # Sequential, 75+ providers, model-agnostic
  loader.sh   # Provider loader utility
```

### Configuration Variables

Each provider config exports these variables:

#### Identity Variables
```bash
PROVIDER_NAME="claude"              # Internal identifier
PROVIDER_DISPLAY_NAME="Claude Code" # Human-readable name
PROVIDER_CLI="claude"               # CLI binary name
```

#### CLI Invocation Variables
```bash
PROVIDER_AUTONOMOUS_FLAG="--dangerously-skip-permissions"
PROVIDER_PROMPT_FLAG="-p"           # Empty for positional prompt
PROVIDER_PROMPT_POSITIONAL=false    # true if prompt is positional arg
```

#### Capability Flags
```bash
PROVIDER_HAS_SUBAGENTS=true    # Can spawn Task tool subagents
PROVIDER_HAS_PARALLEL=true     # Supports parallel execution
PROVIDER_HAS_TASK_TOOL=true    # Has Task tool for agent spawning
PROVIDER_HAS_MCP=true          # Supports MCP server integration (Codex also has basic MCP)
PROVIDER_MAX_PARALLEL=10       # Maximum concurrent agents
```

#### Model Configuration

Models are NOT hardcoded model IDs. Each tier resolves through env indirection
to a tier alias (`providers/claude.sh:70-72`):

```bash
PROVIDER_MODEL_PLANNING="${LOKI_CLAUDE_MODEL_PLANNING:-${LOKI_MODEL_PLANNING:-$CLAUDE_DEFAULT_PLANNING}}"
PROVIDER_MODEL_DEVELOPMENT="${LOKI_CLAUDE_MODEL_DEVELOPMENT:-${LOKI_MODEL_DEVELOPMENT:-$CLAUDE_DEFAULT_DEVELOPMENT}}"
PROVIDER_MODEL_FAST="${LOKI_CLAUDE_MODEL_FAST:-${LOKI_MODEL_FAST:-$CLAUDE_DEFAULT_FAST}}"
```

Defaults are all `sonnet` (`providers/claude.sh:60-62`). Setting
`LOKI_ALLOW_HAIKU` flips the fast tier to `haiku` (`providers/claude.sh:66`).
Do not cite pinned model IDs here; they drift. Read `providers/claude.sh` and
`providers/model_catalog.json` for current values.

#### Rate Limiting
```bash
PROVIDER_RATE_LIMIT_RPM=50      # Requests per minute
PROVIDER_CONTEXT_WINDOW=1000000 # Max context tokens (Opus 4.7: 1M at standard pricing)
PROVIDER_MAX_OUTPUT_TOKENS=128000
```

`PROVIDER_CONTEXT_WINDOW` also caps code-review size. The review diff and prompt
limits derive from it (assuming ~3 bytes per token and ~75% of the window for
input), so a small-window local model is not handed a prompt sized for a 200k
one. The derived value is only ever used to LOWER a cap, and a window at or above
roughly 188889 tokens clamps to the historical 400000/425000 byte defaults, so no
provider shipping today changes behavior (a provider that declares no window
keeps the defaults as well). `LOKI_REVIEW_MAX_DIFF_BYTES` and
`LOKI_REVIEW_MAX_PROMPT_BYTES` still override both.

#### Degraded Mode
```bash
PROVIDER_DEGRADED=false        # true for Codex/Aider
PROVIDER_DEGRADED_REASONS=()   # Array of limitation descriptions
```

---

## Abstract Model Tiers

Loki Mode uses abstract tiers that map to provider-specific configurations:

| Abstract Tier | Purpose | Claude | Codex |
|---------------|---------|--------|-------|
| `planning` | Architecture, PRD analysis | opus | xhigh effort |
| `development` | Implementation, tests | sonnet | high effort |
| `fast` | Simple tasks, docs | haiku | low effort |

### Tier Selection by RARV Phase

```
RARV Phase    -> Abstract Tier -> Provider-Specific
-----------------------------------------------------
REASON        -> planning      -> opus/xhigh
ACT           -> development   -> sonnet/high
REFLECT       -> development   -> sonnet/high
VERIFY        -> fast          -> haiku/low
```

---

## Provider Loader API

### Functions

```bash
# Load a provider configuration
load_provider "claude"  # Returns 0 on success, 1 on failure

# Check if provider is valid
validate_provider "codex"  # Returns 0 if valid

# Check if provider CLI is installed
check_provider_installed "cline"  # Returns 0 if installed

# Auto-detect first available provider
auto_detect_provider  # Echoes provider name or returns 1

# Print provider info
print_provider_info  # Displays loaded provider details

# Print capability matrix
print_capability_matrix  # Shows all providers comparison
```

### Usage Example

```bash
source providers/loader.sh

# Load specific provider
if load_provider "codex"; then
    echo "Loaded: $PROVIDER_DISPLAY_NAME"
    echo "CLI: $PROVIDER_CLI"
    echo "Degraded: $PROVIDER_DEGRADED"
fi

# Auto-detect
if provider=$(auto_detect_provider); then
    load_provider "$provider"
fi
```

---

## Provider Invocation Functions

Each provider exports these functions:

```bash
# Check if CLI is installed
provider_detect()  # Returns 0 if installed

# Get CLI version
provider_version()  # Echoes version string

# Invoke with prompt (autonomous mode)
provider_invoke "Your prompt here"

# Invoke with tier-specific configuration
provider_invoke_with_tier "planning" "Your prompt here"

# Get tier parameter value
provider_get_tier_param "development"  # Returns: opus/sonnet/haiku or xhigh/high/low
```

---

## Degraded Mode Behavior

When running with Codex or Aider:

1. **RARV Cycle executes sequentially** - No parallel agents
2. **Task tool calls are skipped** - Main thread handles all work
3. **Model tier maps to provider configuration:**
   - Codex: `CODEX_MODEL_REASONING_EFFORT` environment variable
4. **Quality gates run sequentially** - No 3-reviewer parallel review
5. **Git worktree parallelism disabled** - `--parallel` flag has no effect

### Degraded Mode Detection

```bash
if [ "$PROVIDER_DEGRADED" = "true" ]; then
    echo "Running in degraded mode"
    echo "Limitations:"
    for reason in "${PROVIDER_DEGRADED_REASONS[@]}"; do
        echo "  - $reason"
    done
fi
```

---

## Rate Limit Detection

The rate limiting system is provider-agnostic:

### Detection Patterns

```bash
# Generic patterns (all providers)
- HTTP 429 status code
- "rate limit" / "rate-limit" / "ratelimit" (case insensitive)
- "too many requests"
- "quota exceeded"
- "request limit"
- "retry-after" header

# Claude-specific
- "resets Xam/pm" format
```

### Fallback Chain

```
1. Provider-specific parsing (Claude's reset time)
   |
   v (if no result)
2. Generic Retry-After header parsing
   |
   v (if no result)
3. Calculated backoff based on PROVIDER_RATE_LIMIT_RPM
```

### Rate Limit Functions

```bash
# Check if output contains rate limit indicators
is_rate_limited "$log_file"  # Returns 0 if rate limited

# Get wait time from rate limit response
detect_rate_limit "$log_file"  # Echoes seconds to wait

# Parse Retry-After header
parse_retry_after "$log_file"  # Echoes seconds

# Calculate default backoff
calculate_rate_limit_backoff  # Uses PROVIDER_RATE_LIMIT_RPM
```

---

## CLI Integration

### Provider Selection

```bash
# Via CLI flag
./autonomy/run.sh --provider codex ./prd.md
loki start --provider cline ./prd.md

# Via environment variable
export LOKI_PROVIDER=codex
./autonomy/run.sh ./prd.md

# Precedence: flag > env > default (claude)
```

### Help Output

```
$ loki start --help

Provider Options:
  --provider PROVIDER    Select AI provider (claude, codex, cline, aider)
                         Default: claude (auto-detect if not installed)

Provider Capability Matrix:
  Provider    Features   Parallel   Task Tool   MCP
  --------------------------------------------------
  claude      Full       Yes (10)   Yes         Yes
  codex       Degraded   No         No          Basic
  cline       Near-Full  No         Yes         Yes
  aider       Degraded   No         No          No
```

---

## Verified CLI Flags

All CLI flags have been verified against actual CLI help output:

| Provider | Flag | Verified Version | Notes |
|----------|------|------------------|-------|
| Claude | `--dangerously-skip-permissions` | v2.1.34 | Autonomous mode |
| Codex | `--sandbox workspace-write` | v0.132.0 | Recommended (--full-auto deprecated 0.125+); legacy: `exec --dangerously-bypass-approvals-and-sandbox` |
| Cline | `--auto-approve` | latest | Autonomous mode |
| Aider | `--yes-always` | latest | Autonomous mode |

---

## Test Coverage

The multi-provider system has 180 tests across 5 test suites:

| Test Suite | Tests | Coverage |
|------------|-------|----------|
| `test-provider-loader.sh` | 12 | Provider loading, validation |
| `test-provider-invocation.sh` | 24 | Invoke functions, tier params |
| `test-provider-degraded-mode.sh` | 19 | Degraded flags, capabilities |
| `test-cli-provider-flag.sh` | 39 | CLI flag parsing, precedence |
| `test-rate-limiting.sh` | 27 | Rate limit detection, backoff |

Run tests:
```bash
for test in tests/test-provider-*.sh tests/test-cli-provider-flag.sh tests/test-rate-limiting.sh; do
    bash "$test"
done
```

---

## Adding New Providers

To add a new provider:

1. Create `providers/<name>.sh` with all required variables
2. Implement the four provider functions:
   - `provider_detect()`
   - `provider_version()`
   - `provider_invoke()`
   - `provider_invoke_with_tier()`
   - `provider_get_tier_param()`
3. Add to `SUPPORTED_PROVIDERS` array in `loader.sh`
4. Update `validate_provider()` regex
5. Add provider case in `run.sh` invocation switch
6. Add tests for new provider

### Provider Template

```bash
#!/bin/bash
# <Provider Name> CLI Provider Configuration

# Provider Identity
PROVIDER_NAME="<name>"
PROVIDER_DISPLAY_NAME="<Display Name>"
PROVIDER_CLI="<cli-binary>"

# CLI Invocation
PROVIDER_AUTONOMOUS_FLAG="<autonomous-flag>"
PROVIDER_PROMPT_FLAG=""  # or "-p" etc
PROVIDER_PROMPT_POSITIONAL=true

# Capability Flags
PROVIDER_HAS_SUBAGENTS=false
PROVIDER_HAS_PARALLEL=false
PROVIDER_HAS_TASK_TOOL=false
PROVIDER_HAS_MCP=false
PROVIDER_MAX_PARALLEL=1

# Model Configuration
PROVIDER_MODEL_PLANNING="<model>"
PROVIDER_MODEL_DEVELOPMENT="<model>"
PROVIDER_MODEL_FAST="<model>"

# Context and Limits
PROVIDER_CONTEXT_WINDOW=128000
PROVIDER_MAX_OUTPUT_TOKENS=32000
PROVIDER_RATE_LIMIT_RPM=60

# Degraded Mode
PROVIDER_DEGRADED=true
PROVIDER_DEGRADED_REASONS=(
    "Reason 1"
    "Reason 2"
)

# Provider Functions
provider_detect() {
    command -v <cli-binary> >/dev/null 2>&1
}

provider_version() {
    <cli-binary> --version 2>/dev/null | head -1
}

provider_invoke() {
    local prompt="$1"
    shift
    <cli-binary> <autonomous-flag> "$prompt" "$@"
}

provider_get_tier_param() {
    local tier="$1"
    case "$tier" in
        planning) echo "<planning-param>" ;;
        development) echo "<dev-param>" ;;
        fast) echo "<fast-param>" ;;
        *) echo "<default-param>" ;;
    esac
}

provider_invoke_with_tier() {
    local tier="$1"
    local prompt="$2"
    shift 2
    local param=$(provider_get_tier_param "$tier")
    # Provider-specific tier invocation
    <cli-binary> <autonomous-flag> "$prompt" "$@"
}
```

---

## Related Documentation

- `skills/providers.md` - User-facing provider guide
- `skills/model-selection.md` - Model tier selection patterns
- `references/core-workflow.md` - RARV cycle documentation
- `docs/INSTALLATION.md` - Installation instructions per provider
