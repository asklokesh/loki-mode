# BMAD Method x Loki Mode Voice Agent -- Council Analysis

**Date:** 2026-02-25
**Council:** 3 Opus reviewers (blind review)
**Verdict:** Unanimous YES with phased approach

## Proposal Summary

Integrate the BMAD Method (https://github.com/bmad-code-org/BMAD-METHOD) with Loki Mode
to create a structured requirements elicitation pipeline. BMAD provides a 4-phase
workflow (Analysis, Planning, Solutioning, Implementation) with agent personas, step-file
architecture, and adversarial review -- complementing Loki Mode's autonomous execution engine.

## Council Findings

### Reviewer 1: Architecture Focus

**Vote:** YES (phased)

- BMAD's step-file architecture aligns with Loki's progressive disclosure model
- BMAD artifacts (product-brief, PRD, architecture, epics) map cleanly to Loki's SDLC phases
- Context budget is manageable: BMAD step files load one-at-a-time (~3K tokens each)
- Integration surface is well-defined: `.loki/queue/`, `build_prompt()`, event bus
- Risk: BMAD is an external dependency that may change format without notice

### Reviewer 2: Integration Feasibility

**Vote:** YES (phased)

- BMAD PRD output sections (Functional Requirements, Success Criteria, User Journeys)
  match most of prd-analyzer.py's existing dimension patterns
- Agent overlap is complementary, not conflicting: BMAD covers pre-development, Loki covers execution
- Voice.sh needs significant extension for structured dialogue (currently only 4-section dictation)
- MIT license is fully compatible with Loki Mode's distribution
- Risk: Voice agent layer (Phase 3) has highest uncertainty; STT reliability for technical terms

### Reviewer 3: Risk and Quality

**Vote:** YES (phased, with gates)

- Backward compatibility is achievable: BMAD integration is additive (new flag, new adapter)
- Existing non-BMAD projects are untouched unless `--bmad-project` is explicitly used
- Quality gates apply to all new code: 3-reviewer blind review, anti-sycophancy, test coverage
- BMAD's adversarial review methodology strengthens Loki's existing quality gate system
- Risk: Scope creep from Epic 2 (engine embedding) and Epic 3 (voice agent) -- phase gates essential

## Recommended Phased Approach

| Phase | Epic | Priority | Risk |
|-------|-------|----------|------|
| P0 | BMAD Artifact Pipeline (parse, score, load) | Must-have | Low |
| P1 | BMAD Engine Embedding (agent YAML parser, step processor) | Should-have | Medium |
| P2 | Voice Agent Layer (structured dialogue, BMAD-to-voice) | Nice-to-have | High |

## Key Constraints

1. P0 must ship independently and prove value before P1/P2 begin
2. No runtime dependency on BMAD repo -- adapter reads BMAD output artifacts only
3. Zero regression on existing non-BMAD workflows
4. All code must pass existing 9-gate quality system
5. Context budget: BMAD additions must stay under 15K tokens per iteration
