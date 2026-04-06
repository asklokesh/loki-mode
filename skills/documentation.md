# Documentation Skill Module

## Research Foundation

| Source | Key Contribution | Citation |
|--------|-----------------|----------|
| Repowise | Codebase intelligence via MCP tools (overview, risk, context, search) | [repowise.dev](https://repowise.dev/) |
| Diátaxis | Documentation system: tutorials, how-to, reference, explanation | [diataxis.fr](https://diataxis.fr/) |
| Google Developer Docs | Style guide for technical documentation | [developers.google.com/style](https://developers.google.com/style) |

---

## When to Load This Module

- Writing or updating documentation
- Running `loki docs` commands
- After build completion for doc generation
- When Repowise MCP is available
- Architecture documentation tasks

---

## Documentation Types

| Type | Description | Trigger |
|------|-------------|---------|
| README.md | Project overview, setup, usage | New project or major changes |
| ARCHITECTURE.md | System design, data flow | Architecture phase |
| API.md | Public API reference | API changes |
| SETUP.md | Dev environment setup | Dependency changes |
| COMPONENTS.md | Per-component docs | New components |
| TESTING.md | Test strategy, coverage | Test changes |
| DECISIONS.md | Architectural decisions | Design decisions made |
| CLAUDE.md | AI agent context | Every iteration |

---

## Model Selection

- **Documentation generation:** Sonnet (standard tier)
- **Doc checking/validation:** Haiku (fast tier)
- **Architecture documentation:** Opus (planning tier)

---

## Repowise Integration

When Repowise MCP tools are available (check tool list for `get_overview`, `get_context`, `get_risk`):

1. Prefer Repowise tools over native file scanning for context gathering
2. Use `get_overview()` as the foundation for ARCHITECTURE.md
3. Use `get_risk()` to prioritize which components need documentation most
4. Use `search_codebase()` for finding related code when documenting
5. Use `get_architecture_diagram(module)` for generating Mermaid component diagrams
6. Use `get_why(query)` to populate DECISIONS.md with architectural rationale

When Repowise is NOT available:

1. Fall back to native git analysis (`loki docs generate`)
2. Use file tree scanning for context
3. Use `git log` for change history

### Detection

Repowise MCP is detected automatically when `.claude/mcp.json` contains a `repowise` server entry. Loki Mode injects Repowise instructions into the build prompt when detected.

---

## Documentation Quality Criteria

- **Accuracy:** Matches current code behavior
- **Completeness:** All public APIs documented
- **Freshness:** Updated within 10 commits of code changes
- **Readability:** Clear, concise, follows project conventions
- **Actionable:** Setup docs enable a new developer to start in <10 min

---

## Prompts

### For README generation

```
Analyze this project and generate a comprehensive README.md. Include: project name,
description, features, quick start, installation, usage examples, configuration,
API reference summary, contributing guidelines, and license. Be concise and practical.
```

### For ARCHITECTURE generation

```
Analyze this project's architecture. Document: system overview, component diagram
(mermaid), data flow, key design decisions, tech stack rationale, deployment
architecture, and scaling considerations. Focus on WHY decisions were made, not
just WHAT exists.
```

### For API documentation

```
Document all public APIs in this project. For each endpoint/function/class:
signature, parameters with types, return values, examples, error cases. Group by
module/route. Include curl examples for HTTP APIs.
```

### For DECISIONS documentation

```
Review git history and code comments for architectural decisions. For each decision:
context (what problem was being solved), decision (what was chosen), rationale
(why this option), alternatives considered, and consequences. Use ADR format.
```

---

## Integration with Other Skills

| Skill | Interaction |
|-------|-------------|
| `quality-gates.md` | Gate 7 checks documentation freshness |
| `artifacts.md` | Documentation generation uses artifact patterns |
| `healing.md` | Healing archaeology feeds into institutional knowledge docs |
| `agents.md` | `documentation-writer` agent type for parallel doc generation |
