import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReviewStageAgent, loadRoleAgent } from "../../src/council/role_agents.ts";
import { configuredReviewer } from "../../src/engine10/stages/xreview.ts";

function fixture(files: Record<string, string>): { repo: string; env: NodeJS.ProcessEnv; done: () => void } {
  const repo = mkdtempSync(join(tmpdir(), "role-agents-"));
  const dir = join(repo, ".loki", "agents");
  mkdirSync(dir, { recursive: true });
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
  const env: NodeJS.ProcessEnv = { LOKI_AGENTS_USER_DIR: join(repo, "no-user-agents") };
  return { repo, env, done: () => rmSync(repo, { recursive: true, force: true }) };
}
const agent = (extra: string, body = "Be strict."): string => `---\ndescription: d\n${extra}\n---\n${body}\n`;

describe("role agents", () => {
  test("reviewer.md supplies prompt, provider and model", () => {
    const f = fixture({ "reviewer.md": agent("model: opus\nprovider: claude", "Review hard.") });
    try {
      const a = loadRoleAgent(f.repo, "reviewer", f.env);
      expect(a).toMatchObject({ role: "reviewer", provider: "claude", model: "opus", prompt: "Review hard." });
      expect(configuredReviewer(f.repo, f.env)).toEqual({ prompt: "Review hard.", model: "opus", provider: "claude" });
    } finally { f.done(); }
  });
  test("role: council key on a differently named file is honoured, codex model is dropped", () => {
    const f = fixture({ "judge.md": agent("role: council\nprovider: codex\nmodel: gpt-x") });
    try {
      expect(loadRoleAgent(f.repo, "reviewer", f.env)).toBeNull();
      const a = loadReviewStageAgent(f.repo, f.env);
      expect(a?.name).toBe("judge");
      expect(configuredReviewer(f.repo, f.env)).toEqual({ prompt: "Be strict.", model: "", provider: "codex" });
    } finally { f.done(); }
  });
  test("non-role agents, empty bodies and bad files yield null", () => {
    const f = fixture({ "tester.md": agent(""), "reviewer.md": "no frontmatter", "council.md": "---\ndescription: d\n---\n" });
    try {
      expect(loadReviewStageAgent(f.repo, f.env)).toBeNull();
      expect(configuredReviewer(f.repo, f.env)).toBeNull();
    } finally { f.done(); }
  });
  test("unsupported provider yields null review provider (default behavior unchanged)", () => {
    const f = fixture({ "reviewer.md": agent("provider: aider") });
    try { expect(configuredReviewer(f.repo, f.env)?.provider).toBeNull(); } finally { f.done(); }
  });
});
