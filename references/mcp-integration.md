# MCP Integration Reference

Model Context Protocol (MCP) servers extend Claude Code's capabilities with specialized tools.

---

## Recommended MCP Servers

### 1. Playwright MCP (E2E Testing)

**Purpose:** Browser automation for end-to-end testing and visual verification.

**When to use:**
- Feature verification (visual confirmation)
- E2E test automation
- Screenshot capture for artifacts

**Configuration:**
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@anthropic-ai/playwright-mcp"]
    }
  }
}
```

**Tools provided:**
- `browser_navigate` - Navigate to URL
- `browser_click` - Click elements
- `browser_type` - Type text
- `browser_screenshot` - Capture screenshots

**SDLC Phase:** QA (E2E testing)

**Limitation:** Cannot detect browser-native alert modals. Use custom UI for confirmations.

---

### 2. Parallel AI (Web Research)

**Purpose:** Production-grade web research with evidence-based results and provenance.

**Why Parallel AI:**
- 48% accuracy on complex research tasks (vs native LLM search)
- Evidence-based results with provenance for every atomic output
- Monitor API for tracking web changes (dependencies, competitors)
- Task API with custom input/output schemas for structured research

**When to use:**
- Discovery phase: PRD gap analysis, competitor research
- Web Research phase: Feature comparisons, market analysis
- Dependency Management: Security advisory monitoring

**Configuration:**
```json
{
  "mcpServers": {
    "parallel-search": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/parallel-search-mcp"],
      "env": {
        "PARALLEL_API_KEY": "your-api-key"
      }
    },
    "parallel-task": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/parallel-task-mcp"],
      "env": {
        "PARALLEL_API_KEY": "your-api-key"
      }
    }
  }
}
```

**Tools provided:**

| Tool | Purpose | Use Case |
|------|---------|----------|
| `parallel_search` | Web search with LLM-optimized excerpts | Quick lookups, fact-checking |
| `parallel_extract` | Extract content from specific URLs | Documentation parsing |
| `parallel_task` | Complex research with custom schemas | Competitor analysis, market research |
| `parallel_monitor` | Track web changes with webhooks | Dependency updates, security alerts |

**SDLC Phases:** Discovery, Web Research, Continuous Monitoring

**Pricing:** Pay-per-query (not token-based). See https://parallel.ai/pricing

**API Documentation:** https://docs.parallel.ai/

---

## MCP Configuration Location

Claude Code reads MCP configuration from:

1. **Project-level:** `.claude/mcp.json` (recommended for project-specific tools)
2. **User-level:** `~/.claude/mcp.json` (for global tools)

Example full configuration:
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@anthropic-ai/playwright-mcp"]
    },
    "parallel-search": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/parallel-search-mcp"],
      "env": {
        "PARALLEL_API_KEY": "${PARALLEL_API_KEY}"
      }
    }
  }
}
```

---

## Using MCP Tools in Loki Loop

MCP tools are automatically available to Claude Code when configured. The orchestrator can dispatch agents that use these tools:

```python
# Agent using Playwright for E2E verification
Task(
    subagent_type="general-purpose",
    model="sonnet",
    description="Verify login feature visually",
    prompt="""
    Use Playwright MCP to:
    1. Navigate to http://localhost:3000/login
    2. Fill in test credentials
    3. Click login button
    4. Take screenshot of dashboard
    5. Verify user name is displayed
    """
)

# Agent using Parallel AI for research
Task(
    subagent_type="general-purpose",
    model="opus",
    description="Research competitor pricing",
    prompt="""
    Use Parallel AI Task API to:
    1. Research top 5 competitors in [market]
    2. Extract pricing tiers from each
    3. Return structured comparison table

    Output schema: {competitors: [{name, tiers: [{name, price, features}]}]}
    """
)
```

---

## When NOT to Use MCP

- **Simple searches:** Claude's built-in `WebSearch` is sufficient for basic lookups
- **Cost sensitivity:** MCP tools add API costs on top of Claude costs
- **Offline work:** MCP tools require network access

---

## Adding New MCP Servers

When evaluating new MCP servers for Loki Loop integration, assess:

1. **Autonomous fit:** Does it work without human intervention?
2. **Evidence quality:** Does it provide verifiable, citable results?
3. **SDLC alignment:** Which phase(s) does it enhance?
4. **Cost model:** Predictable pricing for autonomous operation?
5. **Error handling:** Does it fail gracefully?

---

## References

- [MCP Specification](https://modelcontextprotocol.io/)
- [Parallel AI Documentation](https://docs.parallel.ai/)
- [Playwright MCP](https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-playwright)
