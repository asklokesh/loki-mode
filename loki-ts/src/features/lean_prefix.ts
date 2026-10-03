// S41-09: LOKI_E10_PREFIX=lean replaces the claude_code preset system prompt with this fixed string for engine10 sessions (D41 item 2, D42 item 1).
// It must stay a plain constant -- no stage, task or timestamp interpolation
// -- so every stage prompt shares a byte-identical leading block and the
// provider's prompt cache hits. Per-task content is the caller's own prompt, appended after this block by the SDK, never here. Data only: this file is a string, no imports, no
// verdict logic, nothing engine10/stages/ needs to import back.
export const LEAN_PREFIX =
  "You are Loki, an autonomous coding agent. Follow the task prompt exactly " +
  "and report only what you did.";

// D61-02: LOKI_SPEED (default on; =0 off) starts every stage brief with this one constant (over 200 bytes, no interpolation) so stage prompts share a
// byte-identical leading block for the provider prompt cache. FC-19: role-neutral; plan, Wall and implement all share it, so the full-job text lives only in FIXED_RULES (the implement brief).
export const STAGE_PREFIX =
  "You are Loki, an autonomous coding agent working one stage of a run. " +
  "Follow the stage prompt exactly, including the role it gives you and the rules it sets, " +
  "and report only what you did. " +
  "Stage-specific instructions and the task follow this block.";
export const withStagePrefix = (brief: string): string =>
  process.env["LOKI_SPEED"] !== "0" ? `${STAGE_PREFIX}\n\n${brief}` : brief;
