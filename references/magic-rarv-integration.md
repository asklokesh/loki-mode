# Magic Modules in the RARV-C cycle

Magic Modules is embedded in the autonomous orchestrator. Users do not
run `loki magic` commands directly unless they want manual override.
Agents invoke component generation, debate, and memory capture as part of
normal RARV-C phase execution.

This reference describes which phase does what.

## BOOTSTRAP (before iteration 1)
- `analyze_git_intelligence()` runs (from v6.75.0).
- Magic-specific bootstrap:
  - `magic.core.design_tokens.DesignTokens.extract_from_codebase(save=True)`
    scans existing React and Web Components to learn the project's design
    language. Result is stored at `.loki/magic/tokens.json`.
  - Token extraction runs once per project; subsequent iterations read from
    the saved file. Force re-extract with `rm .loki/magic/tokens.json`.
- PRD scanner (`magic.core.prd_scanner.scan_and_seed`) reads the PRD and
  seeds stub specs at `.loki/magic/specs/<Name>.md` for every UI component
  the PRD mentions with high or medium confidence. Agents refine these
  stubs during REASON and ACT phases.

## REASON (start of each iteration)
- Agents read existing specs from `.loki/magic/specs/` as part of the
  context injected by `build_prompt()`.
- `magic.core.memory_bridge.recall_similar_components()` surfaces prior
  successful patterns for components with matching tags. Agents reuse these
  patterns rather than designing from scratch.

## ACT (the agent does work)
- Agents do NOT need to invoke `loki magic generate` manually. The build
  prompt tells them: write or update the markdown spec at
  `.loki/magic/specs/<Name>.md` and the orchestrator regenerates
  implementations during VERIFY.
- If an agent needs to create a component not yet in the PRD, it writes
  the spec and the next VERIFY pass picks it up.

## VERIFY (end of each iteration)
- `run_magic_debate_gate()` runs as Gate 12 (after Gate 11 documentation).
- Sequence:
  1. `loki magic update` regenerates any components whose specs are newer
     than their implementations (SHA256 freshness check).
  2. `loki magic debate <latest>` runs 2 rounds of the 4-persona debate
     (Creative, Conservative, A11y, Performance).
  3. If any persona returns `severity: block`, Gate 12 fails and the
     iteration does not close. Agent receives the block reasons in the
     next REASON phase and refines the spec.
- Controllable via `LOKI_GATE_MAGIC_DEBATE=false` for prototyping.

## COMPOUND (after iteration or run completes)
- `_magic_compound_capture()` calls
  `magic.core.memory_bridge.capture_iteration_compound()`.
- Memory writes:
  - Episodic: each generated component with its debate result and timing
  - Semantic: tag clusters that consistently pass debate (3+ components,
    >=80% pass rate) become "stable patterns" future iterations reuse
  - Procedural: refinements to design tokens that survived multiple
    iterations become promoted defaults

## Human in the loop escalation
Only one path requires human attention: when Gate 12 returns a block and
the agent's spec refinement does not resolve it after 2 additional
iterations. Orchestrator writes `.loki/signals/MAGIC_HITL_NEEDED` with
the component name and block reasons; dashboard surfaces this in the
Magic Page review queue.

## End-to-end example
PRD says: "Add a login form with email, password, and submit button."

1. BOOTSTRAP: design tokens extracted (primary=#553DE9, etc.).
   PRD scanner seeds `LoginForm.md`, `SubmitButton.md`.
2. Iteration 1 REASON: agent reads both stubs, sees they are placeholders.
3. Iteration 1 ACT: agent writes full props, behavior, a11y into the specs.
4. Iteration 1 VERIFY: Gate 12 runs update (generates React + WC variants)
   and debate. A11y persona blocks `SubmitButton` ("missing aria-disabled
   when submitting"). Gate 12 fails.
5. Iteration 2 REASON: agent reads block reason from `.loki/signals/` and
   updates the spec's Accessibility section.
6. Iteration 2 VERIFY: debate passes. Gate 12 passes. Iteration closes.
7. COMPOUND: episode stored ("LoginForm generated, debate passed rounds=2,
   12.4s"). Tag cluster `[form, auth]` now tracked with 2/2 pass rate.

## Related
- `skills/magic-modules.md` -- skill module for agents
- `references/magic-modules-patterns.md` -- full API and pattern reference
- `references/memory-system.md` -- memory engine details
- `skills/quality-gates.md` -- all 8 deterministic quality gates documented
