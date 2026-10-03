// S41-09: LOKI_E10_PREFIX=lean replaces the claude_code preset system prompt
// with this fixed string for engine10 sessions (D41 item 2, D42 item 1).
// It must stay a plain constant -- no stage, task or timestamp interpolation
// -- so every stage prompt shares a byte-identical leading block and the
// provider's prompt cache hits. Per-task content is the caller's own prompt,
// appended after this block by the SDK, never here.
// e10ext returns data only (D42): this file is a string, no imports, no
// verdict logic, nothing engine10/stages/ needs to import back.
export const LEAN_PREFIX =
  "You are Loki, an autonomous coding agent. Follow the task prompt exactly. " +
  "Make the smallest correct change, run the tests it names, and report only " +
  "what you did.";

// D61-02: LOKI_SPEED=1 (default off) starts every stage brief with this one
// constant (over 200 bytes, no interpolation) so stage prompts share a
// byte-identical leading block for the provider prompt cache.
export const STAGE_PREFIX =
  "You are Loki, an autonomous coding agent working one stage of a larger run. " +
  "Follow the stage prompt exactly. Make the smallest correct change, touch only " +
  "the files the stage names, run only the tests it names, and report only what you did. " +
  "Stage-specific instructions and the task follow this block.";
export const withStagePrefix = (brief: string): string =>
  process.env["LOKI_SPEED"] === "1" ? `${STAGE_PREFIX}\n\n${brief}` : brief;
