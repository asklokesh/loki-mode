# Magic Modules Skill

## Research Foundation

| Source | Key Contribution | Citation |
|--------|-----------------|----------|
| Roman Nurik (Google Labs) | Spec-first component generation, spec as source of truth, freshness hash | [MagicModules](https://github.com/romannurik/MagicModules) |
| Reto Meier (Google Labs) | Multi-persona debate, conflicting expert critique, consensus-with-escalation | [MoMoA](https://github.com/retomeier/momoa) |
| Loki Mode (this adaptation) | Integration with RARV cycle, design tokens, dual-target generation | Internal |

This module is an adaptation of the two Google Labs experiments listed above. It is not a port or a fork -- the spec format, debate protocol, and registry schema are re-implemented to fit Loki Mode's architecture.

---

## When to Load This Module

- User mentions `loki magic` or component generation
- Task involves building new UI components from specs or descriptions
- PRD describes UI components that don't exist yet
- User provides a screenshot or wireframe and wants code
- A build phase needs to scaffold a component library
- Regenerating components whose specs have drifted from their implementation

---

## Core Concept

Magic Modules implements a spec-driven component generation workflow with multi-persona debate for quality. It combines two patterns:

### 1. Spec-First Generation (MagicModules -- Roman Nurik)

- User writes or describes a desired component
- System generates a markdown spec describing props, behavior, a11y, visual style
- Spec becomes the source of truth
- Implementation regenerates when the spec changes (SHA freshness check)
- Generated files carry a `LOKI-MAGIC-HASH` marker so the system knows which implementation belongs to which spec revision

### 2. Multi-Persona Debate (MoMoA -- Reto Meier)

- Generated code is reviewed by conflicting expert personas
- Creative Developer, Conservative Engineer, A11y Advocate, Performance Engineer
- Three rounds of debate produce refined code or escalate to human (HITL)
- Consensus resolves to merged diff; deadlock escalates

The combination means: specs drive generation, debate drives quality, and the registry keeps them coherent.

---

## Commands

| Command | Purpose |
|---------|---------|
| `loki magic generate <name>` | Create a new component from a description or a screenshot |
| `loki magic update` | Regenerate components whose specs changed since the last build |
| `loki magic list` | Browse the component registry (filterable by tag, target, freshness) |
| `loki magic debate <name>` | Run a multi-persona debate on an existing component |
| `loki magic registry stats` | Registry overview (count by target, stale count, recent edits) |
| `loki magic tokens extract` | Observe the codebase and extract design tokens into `.loki/magic/tokens.json` |
| `loki magic snapshot <name>` | Capture a visual regression snapshot for a component |
| `loki magic diff <name>` | Show the diff between the current implementation and what would be regenerated |

---

## Workflow Integration

### With RARV Cycle

- **Reason** phase reads the spec to understand intent before generation
- **Act** phase calls `loki magic generate` or `loki magic update` to produce code
- **Reflect** phase examines debate transcripts for unresolved persona concerns
- **Verify** phase runs `loki magic debate` on newly-generated components and fails the gate if any persona returns `severity=block`

### With Documentation System (`loki docs`)

- Component specs auto-populate the COMPONENTS.md section of project docs
- Registry metadata flows into the ARCHITECTURE.md component diagram
- Freshness hashes appear in CHANGELOG entries when components are regenerated

### With Git Intelligence

- Hotspot components (frequently regenerated) get prioritized debate rounds and additional personas
- Co-change analysis: when a spec changes, debate considers downstream consumers identified by import graph
- Stale-spec detection runs on every `loki docs update`

### With Quality Gates

- Gate 11 (documentation coverage) now includes component docs -- each spec becomes part of COMPONENTS.md
- Gate 5 (test coverage) applies to generated tests in `.loki/magic/generated/tests/`
- A new healing-style hook blocks merging when a component's spec has been manually edited but the implementation was not regenerated

---

## File Layout

```
.loki/magic/
  specs/              # User-editable markdown specs (source of truth)
  generated/
    react/            # Generated *.tsx (TypeScript + Tailwind)
    webcomponent/     # Generated *.js (LokiElement base class, Shadow DOM)
    tests/            # Generated *.test.* (Vitest for React, Playwright for WC)
  registry.json       # Component registry (versions, tags, hashes, targets)
  snapshots/          # Visual regression snapshots (PNG per component variant)
  tokens.json         # Project design token overrides
  debates/            # Persisted debate transcripts per component revision
```

All files under `.loki/magic/generated/` carry a `LOKI-MAGIC-HASH: <sha>` header comment matching the hash stored in `registry.json` for the corresponding spec.

---

## Design Tokens

All generated components use design tokens (colors, spacing, typography, motion) so they match Loki Mode's design language. Defaults come from observing existing components in `web-app/src/` and `dashboard-ui/`. Override with:

- `loki magic tokens extract` -- scan the codebase, update `.loki/magic/tokens.json`
- Manual edit of `.loki/magic/tokens.json` -- takes precedence over extraction

Tokens resolve in the following order:
1. Explicit tokens in the component spec
2. Project overrides in `.loki/magic/tokens.json`
3. Extracted defaults from existing codebase
4. Built-in Loki defaults

---

## Generation Targets

| Target | Stack | Test Framework | Used By |
|--------|-------|---------------|---------|
| `react` | TypeScript + React 18 + Tailwind | Vitest + Testing Library | Dashboard UI, web app |
| `webcomponent` | LokiElement base class + Shadow DOM | Playwright | Purple Lab, embeddable widgets |
| `both` | Parallel generation of both variants | Both | Components shared across surfaces |

`both` is the recommended default for any component used in more than one Loki surface. The debate runs once on the shared spec and the resulting changes are applied to both outputs.

---

## Debate Personas

| Persona | Focus | Block-severity triggers |
|---------|-------|------------------------|
| **Creative Developer** | UX polish, delight, modern patterns, animation | Jarring transitions, misaligned visual rhythm |
| **Conservative Engineer** | Stability, conventions, edge cases, backwards compat | Untyped props, missing error boundaries, hidden state |
| **A11y Advocate** | WCAG 2.1 AA, assistive tech, keyboard, focus order | Missing aria labels, color contrast <4.5, focus traps |
| **Performance Engineer** | Bundle size, render cost, reflows, network | Unbounded lists, sync layout thrash, unnecessary re-renders |

If any persona returns `severity=block`, generation is paused and a HITL request is opened via the dashboard notification system. See `references/magic-modules-patterns.md` for the full debate protocol.

---

## Anti-Patterns

- Do NOT edit generated files directly -- edit the spec instead. Direct edits are overwritten on the next `loki magic update`.
- Do NOT skip debate for "simple" components. Debate catches subtle a11y and performance bugs that look fine to a single reviewer.
- Do NOT hardcode colors, spacing, or font sizes. Always reference design tokens.
- Do NOT remove the `LOKI-MAGIC-HASH` header. The freshness protocol depends on it.
- Do NOT commit generated files without their corresponding spec. The registry will report them as orphans.
- Do NOT run debates with only one persona. Consensus-of-one is not consensus.

---

## Quick Reference

```bash
# Generate a Button component for both targets
loki magic generate Button --target both --description "Primary action button with loading state"

# Generate from a screenshot (Claude Vision path)
loki magic generate PricingCard --target react --from-image ./mockups/pricing.png

# Regenerate everything whose spec has changed
loki magic update

# Run a debate on an existing component (3 rounds by default)
loki magic debate Button

# Show registry health
loki magic registry stats

# Preview the diff between current implementation and regenerated output
loki magic diff Button
```

---

## Integration with Other Skills

| Skill | Interaction |
|-------|-------------|
| `skills/healing.md` | Healing-style hooks protect spec edits; friction-map tracks manually edited generated files |
| `skills/documentation.md` | Component specs feed COMPONENTS.md; registry feeds ARCHITECTURE.md |
| `skills/quality-gates.md` | Gate 11 includes component doc coverage; debate block = gate failure |
| `skills/agents.md` | `component-designer`, `a11y-auditor` agent types map to personas |
| `skills/testing.md` | Generated Vitest and Playwright tests execute under the normal test gates |
| `skills/artifacts.md` | Generated components count as artifacts and flow through the artifact pipeline |

---

## See Also

- `references/magic-modules-patterns.md` -- detailed patterns, spec format, debate protocol, MCP tool reference, and worked examples
- `references/memory-system.md` -- how debate transcripts are stored as episodic memory
- MagicModules by Roman Nurik (Google Labs) -- original spec-first generation concept
- MoMoA by Reto Meier (Google Labs) -- original multi-persona debate concept
