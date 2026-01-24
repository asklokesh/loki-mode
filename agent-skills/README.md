# Agent Skills Directory

Modular, declarative skill files for Loki Loop agents following the Vercel Labs agent-skills pattern.

---

## Overview

This directory contains **packaged agent capabilities** that can be dynamically loaded, versioned, and contributed by the community.

**Architecture Pattern:** Vercel Labs agent-skills specification

---

## Skill Structure

Each skill follows this layout:

```
skill-name/
├── SKILL.md          # Declarative instructions for agents
├── scripts/          # Optional automation tooling
├── references/       # Supporting documentation
└── examples/         # Usage examples
```

---

## Available Skills

### Core Skills (Built-in)

| Skill | Description | Agent Types |
|-------|-------------|-------------|
| `prompt-optimization` | Prompt repetition for Haiku agents | All |
| `checkpoint-mode` | Pause for review every N tasks | Orchestrator |
| `confidence-routing` | Multi-tier routing based on confidence | Orchestrator |

---

## Creating New Skills

### 1. Create Skill Directory

```bash
mkdir -p agent-skills/my-skill/{scripts,references,examples}
```

### 2. Write SKILL.md

```markdown
---
name: my-skill
description: What this skill does
agent_types: [eng-frontend, eng-backend]  # Which agents can use this
---

# My Skill

## When to Use

Describe when agents should activate this skill.

## Instructions

Step-by-step guidance for agents:

1. First do this
2. Then do that
3. Finally verify

## Examples

[Usage examples]

## References

[Related documentation]
```

### 3. Add Scripts (Optional)

```bash
# agent-skills/my-skill/scripts/automation.sh
#!/bin/bash
# Automation script called by agents
```

### 4. Test Skill

```bash
# Agents auto-discover skills in this directory
./autonomy/run.sh --skills=my-skill ./prd.md
```

---

## Skill Discovery

Agents automatically discover skills in this directory at runtime:

```python
def discover_agent_skills():
    """Scan agent-skills/ for available skills."""
    skills = []
    skills_dir = Path(__file__).parent / "agent-skills"

    for skill_dir in skills_dir.iterdir():
        if skill_dir.is_dir() and (skill_dir / "SKILL.md").exists():
            skill = load_skill(skill_dir / "SKILL.md")
            skills.append(skill)

    return skills
```

---

## Community Contributions

### Publishing Skills

Skills can be:
1. **Bundled with Loki Loop** (this directory)
2. **Published as separate repos** (following agent-skills spec)
3. **Installed dynamically** via `/install-skill` command

### Skill Package Format

```yaml
name: my-awesome-skill
version: 1.0.0
description: Does something amazing
author: username
repository: https://github.com/user/my-awesome-skill
compatible_with:
  - loki-loop: ">=2.36.0"
  - claude-code: ">=1.0.0"
```

---

## Installation from External Sources

```bash
# Install from GitHub
/install-skill https://github.com/user/skill-repo

# Install from local path
/install-skill /path/to/skill-directory

# List installed skills
/list-skills
```

---

## Best Practices

1. **Single Responsibility** - Each skill does ONE thing well
2. **Clear Activation Conditions** - Specify when agents should use the skill
3. **Examples Included** - Show concrete usage patterns
4. **Version Compatibility** - Document compatible Loki Loop versions
5. **Test Coverage** - Include test cases for skill behavior

---

## Standard Skills Library

The community maintains a registry of verified skills:

- **Security Audits** - OWASP Top 10, CWE scanning
- **Performance Testing** - Load testing, profiling
- **Accessibility** - WCAG compliance checking
- **Mobile Testing** - Responsive design validation
- **API Documentation** - OpenAPI/GraphQL doc generation
- **Deployment Strategies** - Blue-green, canary, rolling updates

See [awesome-loki-skills](https://github.com/asklokesh/awesome-loki-skills) for full catalog.

---

**Pattern Source:** [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills)

**Version:** 1.0.0
