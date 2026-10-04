// CP-ASK slice 7: provider argv for an Ask job.
import { expect, test } from "bun:test";
import { buildInvocation } from "../../src/ask/invoke.ts";
import { ALLOWED_TOOLS, DENIED_TOOLS } from "../../src/ask/policy.ts";

const base = { mcpConfigPath: "/scratch/mcp.json", jobDir: "/scratch", maxUsd: 1 };
const ok = (o: Parameters<typeof buildInvocation>[0]) => { const r = buildInvocation(o); if (!r.ok) throw new Error(r.error); return r; };

test("claude is strict-mcp, deny-listed, never skips permissions, omits the default model and takes the prompt on stdin", () => {
  const r = ok({ ...base, provider: "claude" });
  const a = r.argv;
  expect(a[0]).toBe("claude");
  expect(a).toContain("--strict-mcp-config");
  expect(a[a.indexOf("--mcp-config") + 1]).toBe("/scratch/mcp.json");
  expect(a[a.indexOf("--allowedTools") + 1]).toBe(ALLOWED_TOOLS);
  expect(a[a.indexOf("--disallowedTools") + 1]).toBe(DENIED_TOOLS);
  expect(a[a.indexOf("--tools") + 1]).toBe("");
  expect(a[a.indexOf("--max-budget-usd") + 1]).toBe("1");
  expect(a).toContain("stream-json");
  expect(a).not.toContain("--dangerously-skip-permissions");
  expect(a).not.toContain("--model");
  expect(a).not.toContain("bypassPermissions");
  expect(r.promptVia).toBe("stdin");
});

test("an explicit model is passed through only when valid", () => {
  expect(ok({ ...base, provider: "claude", model: "sonnet" }).argv).toContain("--model");
  expect(buildInvocation({ ...base, provider: "claude", model: "--evil" }).ok).toBe(false);
});

test("codex runs in a read-only sandbox in the scratch dir", () => {
  const a = ok({ ...base, provider: "codex" }).argv;
  expect(a.slice(0, 2)).toEqual(["codex", "exec"]);
  expect(a[a.indexOf("--sandbox") + 1]).toBe("read-only");
  expect(a).toContain("--json");
  expect(a[a.indexOf("-C") + 1]).toBe("/scratch");
  expect(a.join(" ")).not.toContain("bypass");
  expect(a.join(" ")).not.toContain("full-auto");
});

test("cline and aider are refused with the MCP message; unknown providers too", () => {
  for (const p of ["cline", "aider", "opencode"]) {
    const r = buildInvocation({ ...base, provider: p });
    expect(r).toEqual({ ok: false, error: "Ask needs claude or codex for now" });
  }
  expect(buildInvocation({ ...base, provider: "gemini" }).ok).toBe(false);
});

test("a custom binary overrides only argv[0]", () => {
  expect(ok({ ...base, provider: "claude", bin: "/x/fake-claude" }).argv[0]).toBe("/x/fake-claude");
});
