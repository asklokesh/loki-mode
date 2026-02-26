# BMAD Integration Validation Report

**Date:** 2026-02-25
**Validator:** Automated analysis against Loki Mode v6.0.0 codebase
**BMAD Version:** Latest main (cloned 2026-02-25)

## Decision: GO (Phase 0 / Epic 1 only)

Phase 0 (BMAD Artifact Pipeline) is low-risk, additive, and achievable with the current
codebase. Phases 1-2 are deferred pending P0 value validation.

---

## 1. Compatibility Matrix

| Integration Point | Status | Notes |
|---|---|---|
| PRD format parsing | Compatible (minor gaps) | 7/9 analyzer dimensions match BMAD headings directly |
| Artifact chain discovery | New capability needed | Adapter must find `_bmad-output/planning-artifacts/` |
| Agent personas | Complementary | BMAD pre-dev agents + Loki execution agents = full coverage |
| Voice capabilities | Insufficient for P2 | voice.sh only does 4-section dictation, not structured dialogue |
| Context budget | Safe | ~8-15K tokens per iteration (step files load one-at-a-time) |
| License | MIT -- fully compatible | No restrictions on integration or redistribution |
| Event bus integration | Ready | `.loki/events/pending/` accepts BMAD artifact events |
| Memory system | Ready | BMAD artifacts can be stored as episodic memory |
| CLI integration | Straightforward | `--bmad-project` flag pattern matches existing CLI architecture |
| Dashboard | Deferred (P1) | Would need new "Elicitation" panel |

## 2. PRD Format Gap Analysis

### BMAD PRD Section Headings vs Loki Analyzer Dimensions

| BMAD PRD Section | Loki Dimension | Match Type |
|---|---|---|
| `## Executive Summary` | -- | NO MATCH (no heading pattern covers "executive summary") |
| `## Project Classification` | -- | NO MATCH |
| `## Success Criteria` | `acceptance_criteria` | PARTIAL (heading pattern matches "criteria" keyword) |
| `## Product Scope` | `feature_list` | MATCH (heading pattern matches "scope") |
| `## User Journeys` | `user_stories` | MATCH (heading pattern matches "user.*journey") |
| `## Domain-Specific Requirements` | -- | NO MATCH |
| `## Innovation & Novel Patterns` | -- | NO MATCH |
| `## [ProjectType] Specific Requirements` | `feature_list` | PARTIAL (matches "requirement") |
| `## Project Scoping & Phased Development` | `feature_list` | PARTIAL (matches "scope") |
| `## Functional Requirements` | `feature_list` | MATCH (matches "functional" and "requirement") |
| `## Non-Functional Requirements` | Multiple | MATCH (content patterns for security, deployment, error handling) |

### Content Pattern Matches

| BMAD Content Pattern | Loki Content Pattern | Match? |
|---|---|---|
| `FR{N}: [Actor] can [capability]` | `user can/should/will` in `user_stories` | YES |
| `Given/When/Then` (in epics) | `given.*when.*then` in `acceptance_criteria` | YES |
| `As a {role}, I want {action}` (stories) | `as a \w+` in `user_stories` | YES |
| Tech stack mentions in architecture.md | Tech keyword patterns in `tech_stack` | YES |
| `### Performance`, `### Security` (NFRs) | Security/deployment heading patterns | YES |

### Gaps Requiring Adapter Work

1. **Executive Summary** -- BMAD's most prominent section has no matching Loki dimension.
   Adapter should map this to a "project_overview" meta-dimension.

2. **Project Classification** -- BMAD includes project type, domain, complexity.
   No Loki equivalent. Adapter should extract and pass as metadata.

3. **Domain-Specific Requirements** -- Healthcare, fintech, govtech compliance sections.
   No Loki dimension covers domain compliance. Consider adding as optional dimension.

4. **Innovation & Novel Patterns** -- BMAD-specific section.
   Not needed for scoring; pass through as supplementary context.

5. **Frontmatter parsing** -- BMAD documents have YAML frontmatter with `stepsCompleted`,
   `inputDocuments`, `workflowType`. Loki's prd-analyzer.py ignores frontmatter entirely.
   Adapter must strip frontmatter before passing to analyzer OR extend analyzer.

### Scoring Impact

A well-formed BMAD PRD would score approximately **7.5-8.5/10** on the current analyzer
without any changes:
- `feature_list`: HIGH (## Functional Requirements + bullet lists)
- `user_stories`: HIGH (## User Journeys + "As a..." stories in epics)
- `acceptance_criteria`: HIGH (Given/When/Then in epics)
- `tech_stack`: PARTIAL-HIGH (architecture.md has tech details, PRD may not)
- `security`: PARTIAL (## Non-Functional Requirements > ### Security)
- `deployment`: PARTIAL (may be in architecture.md, not PRD)
- `data_model`: NONE-PARTIAL (usually in architecture.md, not PRD)
- `api_spec`: NONE-PARTIAL (usually in architecture.md, not PRD)
- `error_handling`: PARTIAL (## Non-Functional Requirements may cover this)

With an adapter that also feeds architecture.md into the analyzer, score would be **9-10/10**.

## 3. Agent Overlap Analysis

### BMAD Agents (8) vs Loki Agent Types (41)

| BMAD Agent | Role | Loki Equivalent(s) | Relationship |
|---|---|---|---|
| Mary (Analyst) | Business analysis, research | `prod-pm` (partial) | Complementary -- BMAD analyst is pre-development |
| John (PM) | PRD creation, validation | `prod-pm`, `orch-planner` | Overlapping -- Loki PM focuses on execution planning |
| Winston (Architect) | Architecture design | `eng-infra`, `orch-planner` | Complementary -- BMAD architect is pre-code |
| Sally (UX Designer) | UX specification | `prod-design` | Complementary -- BMAD UX is spec, Loki is implementation |
| Amelia (Developer) | Code implementation | `eng-*` (8 agents) | Superseded -- Loki has specialized dev agents |
| Bob (Scrum Master) | Sprint planning | `orch-coordinator` | Overlapping -- different abstraction level |
| Quinn (QA) | E2E test generation | `eng-qa` | Overlapping -- both generate tests |
| Barry (Quick Flow) | Solo rapid dev | No equivalent | Unique to BMAD |

### Assessment

- **Zero conflict.** BMAD agents operate in the pre-development space (requirements, planning,
  architecture). Loki agents operate in the execution space (coding, testing, deploying).
- **Clear handoff point:** BMAD produces artifacts (PRD, architecture, epics). Loki consumes
  them. The adapter bridges the format gap.
- **Party Mode** (multi-agent collaboration) is a BMAD concept that could enrich Loki's
  council-based review in future phases.

## 4. Voice Compatibility Assessment

### Current Capabilities (voice.sh)

| Capability | Status |
|---|---|
| STT (Speech-to-Text) | Whisper API, local Whisper, macOS dictation |
| TTS (Text-to-Speech) | macOS `say`, Linux espeak/festival |
| Audio recording | sox, ffmpeg, arecord |
| Guided dictation | 4-section template only (name, overview, requirements, tech stack) |
| Structured dialogue | NOT SUPPORTED |
| Agent handoff | NOT SUPPORTED |
| Session persistence | NOT SUPPORTED |
| Technical term correction | NOT SUPPORTED |

### What BMAD Voice Integration (P2) Would Require

| Requirement | Effort | Description |
|---|---|---|
| Step-file-to-question mapper | Large | Convert BMAD step instructions to conversational prompts |
| Multi-turn dialogue manager | Large | Track conversation state, handle clarifications, backtracking |
| Agent persona injection | Medium | Voice TTS uses agent voice characteristics |
| Technical term correction loop | Medium | Confirm jargon transcription ("Did you say React or Preact?") |
| Session persistence | Medium | Resume BMAD workflows across voice sessions |
| Dual-mode interface | Large | Voice for elicitation, visual for review |

### Assessment

Voice integration (P2) is the highest-risk phase. The current voice.sh is a thin wrapper
around STT/TTS tools. Transforming it into a structured dialogue system requires:
- New conversation state machine (not just record-transcribe-write)
- BMAD step-file interpreter (convert markdown instructions to conversational flow)
- Feedback loop for transcription accuracy (critical for technical terms)

**Recommendation:** Defer P2 entirely. P0 (artifact pipeline) delivers value without voice.
Voice integration can be revisited after P0 proves the BMAD artifact format is stable and useful.

## 5. Context Budget Analysis

### Per-Iteration Context Cost (P0 Only)

| Component | Tokens | Source |
|---|---|---|
| Loki SKILL.md | ~2,750 | Always loaded |
| RARV instructions | ~1,500 | build_prompt() |
| SDLC phases + rules | ~1,000 | build_prompt() |
| Memory context | ~2,000-5,000 | Memory retrieval |
| PRD content | ~5,000-12,000 | BMAD PRD document |
| PRD observations | ~500-1,000 | prd-analyzer output |
| **BMAD adapter metadata** | **~500-1,000** | **Project classification, artifact chain info** |
| **BMAD architecture summary** | **~2,000-4,000** | **Condensed architecture decisions** |
| **BMAD epic summary** | **~1,000-3,000** | **Active epic/story context** |
| Checklist status | ~500-1,000 | verification-results.json |
| Queue tasks | ~500-2,000 | .loki/queue/ |
| **TOTAL** | **~17,250-32,250** | **Well under 150K ceiling** |

### Verdict

At worst case (~32K tokens), BMAD integration uses ~21% of a 150K context window.
This leaves ample room for code context, tool outputs, and conversation history.
No context pressure risk.

## 6. Risk Register

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| BMAD output format changes in future versions | Medium | Medium | Adapter uses loose pattern matching, not exact schema; version-pin BMAD reference |
| Malformed BMAD artifacts (partial workflow state) | Low | Medium | Adapter validates artifact completeness; falls back to freeform PRD path |
| BMAD `_bmad-output/` not found | Low | Low | Clear error message; `--bmad-project` flag is explicit, not auto-detected |
| prd-analyzer regression on freeform PRDs | High | Low | Test suite includes both BMAD and freeform PRD fixtures; backward compatibility gate |
| Context budget exceeded with very large BMAD PRDs | Low | Low | PRD content is truncated at 12K tokens; architecture summary is condensed |
| BMAD trademark concerns | Low | Low | MIT license permits code use; trademark applies to branding, not API integration |
| Scope creep into P1/P2 during P0 implementation | Medium | Medium | Strict phase gates; P1/P2 deferred until P0 ships and proves value |

## 7. Integration Architecture (P0)

```
User's BMAD project
  _bmad-output/
    planning-artifacts/
      product-brief-*.md
      prd-*.md              <-- Primary input
      architecture.md       <-- Secondary input
      epics.md              <-- Story/task source
    implementation-artifacts/
      sprint-status.yaml
      *.story.md

                    |
                    v

  autonomy/bmad-adapter.py
    - Discover _bmad-output/ structure
    - Parse BMAD frontmatter (stepsCompleted, workflowType)
    - Strip frontmatter, normalize headings
    - Extract project classification metadata
    - Feed normalized PRD to prd-analyzer.py
    - Map epics to .loki/queue/ task format

                    |
                    v

  autonomy/prd-analyzer.py (enhanced)
    - New heading patterns for BMAD sections
    - Architecture.md scoring support
    - BMAD quality bonus (structured methodology)
    - Backward-compatible with freeform PRDs

                    |
                    v

  autonomy/loki --bmad-project <path>
    - Discovery: find _bmad-output/ in project
    - Load: run bmad-adapter.py, then prd-analyzer.py
    - Inject: BMAD metadata into build_prompt()
    - Queue: BMAD epics/stories into .loki/queue/

                    |
                    v

  autonomy/run.sh (build_prompt)
    - BMAD context block injected alongside PRD
    - Architecture decisions as supplementary context
    - Epic/story tracking in checklist system
```

## 8. Recommendations

1. **Proceed with P0 (Epic 1) only.** BMAD Artifact Pipeline.
2. **Do not embed BMAD engine.** Read BMAD outputs, do not execute BMAD workflows.
3. **Do not implement voice integration.** Defer to separate initiative.
4. **Create adapter as standalone Python module.** `autonomy/bmad-adapter.py` -- stdlib only.
5. **Enhance prd-analyzer.py conservatively.** Add patterns, do not restructure.
6. **Test with real BMAD output fixtures.** Create test fixtures from BMAD's own templates.
7. **Gate P1 on P0 success metrics:** At least 5 real projects use `--bmad-project` flag.
