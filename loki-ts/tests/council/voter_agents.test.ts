// loki-ts/tests/council/voter_agents.test.ts -- Phase C (v7.5.20) tests.
//
// Covers:
//   - buildVoterAgentsJson emits exactly 3 slugs and embeds iteration + PRD hint
//   - buildDevilsAdvocateAgent quotes the base findings in its prompt
//   - dispatchClaudeAgents with an injected runner returning canned JSON returns 3 AgentVerdict
//   - dispatchClaudeAgents with an injected runner returning malformed JSON throws
//   - dispatchClaudeAgents throws when injected runner exits non-zero
//   - dispatchClaudeAgents throws when response missing a declared voter

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildVoterAgentsJson,
  buildDevilsAdvocateAgent,
  dispatchClaudeAgents,
  VOTER_SLUGS,
  type ClaudeRunner,
} from "../../src/council/voter_agents.ts";
import { _resetClaudeHelpCacheForTest } from "../../src/providers/claude_flags.ts";
import type { CouncilEvaluateContext, AgentVerdict } from "../../src/runner/council.ts";
import type { RunnerContext } from "../../src/runner/types.ts";

function fakeCtx(opts: { prdPath?: string; iteration?: number } = {}): CouncilEvaluateContext {
  const rc: RunnerContext = {
    cwd: "/tmp",
    lokiDir: "/tmp",
    prdPath: opts.prdPath,
    provider: "claude",
    maxRetries: 1,
    maxIterations: 1,
    baseWaitSeconds: 0,
    maxWaitSeconds: 0,
    autonomyMode: "single-pass",
    sessionModel: "development",
    budgetLimit: undefined,
    completionPromise: undefined,
    iterationCount: opts.iteration ?? 7,
    retryCount: 0,
    currentTier: "development",
    log: () => {},
  };
  return { ctx: rc, iteration: opts.iteration ?? 7 };
}

describe("buildVoterAgentsJson", () => {
  it("emits the 3 expected voter slugs with required AgentSpec fields", () => {
    const agents = buildVoterAgentsJson(fakeCtx());
    const keys = Object.keys(agents).sort();
    expect(keys).toEqual(
      [
        VOTER_SLUGS.CONVERGENCE_VOTER,
        VOTER_SLUGS.REQUIREMENTS_VERIFIER,
        VOTER_SLUGS.TEST_AUDITOR,
      ].sort(),
    );
    for (const k of keys) {
      const a = agents[k]!;
      expect(typeof a.description).toBe("string");
      expect(typeof a.prompt).toBe("string");
      expect(a.prompt.length).toBeGreaterThan(50);
      expect(typeof a.model).toBe("string");
      expect(typeof a.effort).toBe("string");
    }
  });

  it("embeds the iteration number and PRD hint in each voter prompt", () => {
    const td = mkdtempSync(join(tmpdir(), "loki-voter-test-"));
    try {
      const prdPath = join(td, "prd.md");
      writeFileSync(prdPath, "Build a clearly-defined slack bot that schedules standups.");
      const agents = buildVoterAgentsJson(fakeCtx({ prdPath, iteration: 42 }));
      for (const slug of Object.keys(agents)) {
        const p = agents[slug]!.prompt;
        expect(p).toContain("iteration 42");
        expect(p).toContain("slack bot");
        expect(p).toContain(slug);
      }
    } finally {
      rmSync(td, { recursive: true, force: true });
    }
  });

  it("handles missing PRD path gracefully (no throw, emits hint='(none provided)')", () => {
    const agents = buildVoterAgentsJson(fakeCtx({ prdPath: undefined }));
    const sample = agents[VOTER_SLUGS.REQUIREMENTS_VERIFIER]!.prompt;
    expect(sample).toContain("(none provided)");
  });
});

describe("buildDevilsAdvocateAgent", () => {
  // BLIND REVIEW (BUG-QG-009, mirrors bash completion-council.sh:2090-2091):
  // the contrarian must NOT be shown the base voters' member verdicts/reasons,
  // or it is biased toward agreement and the anti-sycophancy gate is defeated.
  // This function was an unwired primitive until the DA was auto-wired; the
  // earlier assertion (base findings quoted in the prompt) encoded the bug and
  // is replaced here with the blind-review contract.
  it("is blind: does NOT leak the base voters' verdicts or reasons into the prompt", () => {
    const baseFindings: AgentVerdict[] = [
      { role: "requirements-verifier", verdict: "APPROVE", reason: "all met", issues: [] },
      { role: "test-auditor", verdict: "APPROVE", reason: "passing", issues: [] },
      { role: "convergence-voter", verdict: "APPROVE", reason: "stable", issues: [] },
    ];
    const da = buildDevilsAdvocateAgent(fakeCtx({ iteration: 11 }));
    expect(da.model).toBe("opus");
    expect(da.effort).toBe("xhigh");
    expect(da.prompt).toContain("iteration 11");
    expect(da.prompt).toContain("devils-advocate");
    expect(da.prompt).toContain("unanimous APPROVE");
    // The per-member reasons must NOT appear -- blind review.
    for (const f of baseFindings) {
      expect(da.prompt).not.toContain(f.reason);
    }
  });
});

describe("dispatchClaudeAgents", () => {
  function cannedRunner(stdout: string, exitCode = 0): ClaudeRunner {
    return async (_argv: string[]) => ({ stdout, exitCode });
  }

  it("returns 3 AgentVerdict when the runner returns valid JSON for all declared voters", async () => {
    const stdout = JSON.stringify({
      findings: [
        {
          role: VOTER_SLUGS.REQUIREMENTS_VERIFIER,
          vote: "APPROVE",
          reason: "ok",
          confidence: 0.9,
        },
        {
          role: VOTER_SLUGS.TEST_AUDITOR,
          vote: "APPROVE",
          reason: "ok",
          confidence: 0.8,
        },
        {
          role: VOTER_SLUGS.CONVERGENCE_VOTER,
          vote: "REJECT",
          reason: "regression",
          confidence: 0.7,
          issues: [{ severity: "HIGH", description: "more failing tasks" }],
        },
      ],
    });
    const out = await dispatchClaudeAgents(fakeCtx(), cannedRunner(stdout));
    expect(out.length).toBe(3);
    const slugs = out.map((v) => v.role).sort();
    expect(slugs).toEqual(
      [
        VOTER_SLUGS.CONVERGENCE_VOTER,
        VOTER_SLUGS.REQUIREMENTS_VERIFIER,
        VOTER_SLUGS.TEST_AUDITOR,
      ].sort(),
    );
    const conv = out.find((v) => v.role === VOTER_SLUGS.CONVERGENCE_VOTER)!;
    expect(conv.verdict).toBe("REJECT");
    expect(conv.issues.length).toBe(1);
  });

  it("throws when runner returns malformed JSON", async () => {
    const bad = cannedRunner("not real json at all", 0);
    await expect(dispatchClaudeAgents(fakeCtx(), bad)).rejects.toThrow();
  });

  it("throws when runner exits non-zero", async () => {
    const stdout = JSON.stringify({ findings: [] });
    const failingRunner = cannedRunner(stdout, 1);
    await expect(dispatchClaudeAgents(fakeCtx(), failingRunner)).rejects.toThrow(/exit/);
  });

  it("throws when the response omits a declared voter", async () => {
    // Only 2 findings; declared set has 3.
    const stdout = JSON.stringify({
      findings: [
        { role: VOTER_SLUGS.REQUIREMENTS_VERIFIER, vote: "APPROVE", reason: "ok", confidence: 0.9 },
        { role: VOTER_SLUGS.TEST_AUDITOR, vote: "APPROVE", reason: "ok", confidence: 0.9 },
      ],
    });
    await expect(dispatchClaudeAgents(fakeCtx(), cannedRunner(stdout))).rejects.toThrow(
      /missing finding/,
    );
  });
});

// EMBED 3 (v7.33.0): --disallowedTools on the council voter argv.
describe("dispatchClaudeAgents EMBED 3 --disallowedTools tree-mutation guard", () => {
  const validStdout = JSON.stringify({
    findings: [
      { role: VOTER_SLUGS.REQUIREMENTS_VERIFIER, vote: "APPROVE", reason: "ok", confidence: 0.9 },
      { role: VOTER_SLUGS.TEST_AUDITOR, vote: "APPROVE", reason: "ok", confidence: 0.9 },
      { role: VOTER_SLUGS.CONVERGENCE_VOTER, vote: "APPROVE", reason: "ok", confidence: 0.9 },
    ],
  });

  // Capturing runner records the argv it is handed, then returns canned output.
  function capturingRunner(captured: { argv: string[] }): ClaudeRunner {
    return async (argv: string[]) => {
      captured.argv = argv;
      return { stdout: validStdout, exitCode: 0 };
    };
  }

  it("passes --disallowedTools with a deny list (default on) when CLI supports it", async () => {
    _resetClaudeHelpCacheForTest("  --agents\n  --json-schema\n  --disallowedTools <tools...>");
    const savedGuard = process.env["LOKI_REVIEW_TOOL_GUARD"];
    delete process.env["LOKI_REVIEW_TOOL_GUARD"];
    const cap = { argv: [] as string[] };
    try {
      await dispatchClaudeAgents(fakeCtx(), capturingRunner(cap));
      const idx = cap.argv.indexOf("--disallowedTools");
      expect(idx).toBeGreaterThanOrEqual(0);
      const denyList = cap.argv[idx + 1] ?? "";
      // Mutating tools denied.
      expect(denyList).toContain("Edit");
      expect(denyList).toContain("Write");
      expect(denyList).toContain("NotebookEdit");
      expect(denyList).toContain("Bash(git reset:*)");
      expect(denyList).toContain("Bash(git push:*)");
      // Read-only git must NOT be in the deny list (reviewer still inspects).
      expect(denyList).not.toContain("Bash(git diff");
      expect(denyList).not.toContain("Bash(git log");
      // The deny list is a single token; the -p prompt must follow it, never be
      // swallowed as a tool name.
      expect(cap.argv[cap.argv.length - 2]).toBe("-p");
    } finally {
      if (savedGuard === undefined) delete process.env["LOKI_REVIEW_TOOL_GUARD"];
      else process.env["LOKI_REVIEW_TOOL_GUARD"] = savedGuard;
    }
  });

  it("never applies --bare (Embed 2) to the voter argv (it would drop auto-discovered context the voter relies on)", async () => {
    _resetClaudeHelpCacheForTest("  --agents\n  --json-schema\n  --disallowedTools <tools...>\n  --bare");
    const savedGuard = process.env["LOKI_REVIEW_TOOL_GUARD"];
    delete process.env["LOKI_REVIEW_TOOL_GUARD"];
    const cap = { argv: [] as string[] };
    try {
      await dispatchClaudeAgents(fakeCtx(), capturingRunner(cap));
      expect(cap.argv.includes("--bare")).toBe(false);
      expect(cap.argv.includes("--agents")).toBe(true);
    } finally {
      if (savedGuard === undefined) delete process.env["LOKI_REVIEW_TOOL_GUARD"];
      else process.env["LOKI_REVIEW_TOOL_GUARD"] = savedGuard;
    }
  });

  it("omits --disallowedTools when LOKI_REVIEW_TOOL_GUARD=0 (opt-out)", async () => {
    _resetClaudeHelpCacheForTest("  --agents\n  --json-schema\n  --disallowedTools <tools...>");
    const savedGuard = process.env["LOKI_REVIEW_TOOL_GUARD"];
    process.env["LOKI_REVIEW_TOOL_GUARD"] = "0";
    const cap = { argv: [] as string[] };
    try {
      await dispatchClaudeAgents(fakeCtx(), capturingRunner(cap));
      expect(cap.argv.includes("--disallowedTools")).toBe(false);
    } finally {
      if (savedGuard === undefined) delete process.env["LOKI_REVIEW_TOOL_GUARD"];
      else process.env["LOKI_REVIEW_TOOL_GUARD"] = savedGuard;
    }
  });

  it("omits --disallowedTools when the CLI does not advertise it (graceful degrade)", async () => {
    _resetClaudeHelpCacheForTest("  --agents\n  --json-schema");
    const savedGuard = process.env["LOKI_REVIEW_TOOL_GUARD"];
    delete process.env["LOKI_REVIEW_TOOL_GUARD"];
    const cap = { argv: [] as string[] };
    try {
      await dispatchClaudeAgents(fakeCtx(), capturingRunner(cap));
      expect(cap.argv.includes("--disallowedTools")).toBe(false);
      // The voter still functions (agents + schema + prompt present).
      expect(cap.argv.includes("--agents")).toBe(true);
      expect(cap.argv[cap.argv.length - 2]).toBe("-p");
    } finally {
      if (savedGuard === undefined) delete process.env["LOKI_REVIEW_TOOL_GUARD"];
      else process.env["LOKI_REVIEW_TOOL_GUARD"] = savedGuard;
    }
  });
});

// EMBED 3b (v7.35.0, #167): --allowedTools positive least-privilege allowlist on
// the council voter argv. DEFAULT OFF; opt in with LOKI_REVIEW_ALLOWLIST=1.
describe("dispatchClaudeAgents EMBED 3b --allowedTools least-privilege allowlist", () => {
  const validStdout = JSON.stringify({
    findings: [
      { role: VOTER_SLUGS.REQUIREMENTS_VERIFIER, vote: "APPROVE", reason: "ok", confidence: 0.9 },
      { role: VOTER_SLUGS.TEST_AUDITOR, vote: "APPROVE", reason: "ok", confidence: 0.9 },
      { role: VOTER_SLUGS.CONVERGENCE_VOTER, vote: "APPROVE", reason: "ok", confidence: 0.9 },
    ],
  });
  function capturingRunner(captured: { argv: string[] }): ClaudeRunner {
    return async (argv: string[]) => {
      captured.argv = argv;
      return { stdout: validStdout, exitCode: 0 };
    };
  }

  const HELP_FULL =
    "  --agents\n  --json-schema\n  --disallowedTools <tools...>\n  --allowedTools <tools...>";

  it("DEFAULT ON: --allowedTools present (alongside the denylist) when LOKI_REVIEW_ALLOWLIST unset", async () => {
    _resetClaudeHelpCacheForTest(HELP_FULL);
    const savedGuard = process.env["LOKI_REVIEW_TOOL_GUARD"];
    const savedAllow = process.env["LOKI_REVIEW_ALLOWLIST"];
    delete process.env["LOKI_REVIEW_TOOL_GUARD"]; // denylist default-on
    delete process.env["LOKI_REVIEW_ALLOWLIST"]; // allowlist default-on (flipped)
    const cap = { argv: [] as string[] };
    try {
      await dispatchClaudeAgents(fakeCtx(), capturingRunner(cap));
      // Allowlist now default-on: present by default.
      expect(cap.argv.includes("--allowedTools")).toBe(true);
      // Deny precedence is safe (verified live), so denylist coexists.
      expect(cap.argv.includes("--disallowedTools")).toBe(true);
      expect(cap.argv[cap.argv.length - 2]).toBe("-p");
    } finally {
      if (savedGuard === undefined) delete process.env["LOKI_REVIEW_TOOL_GUARD"];
      else process.env["LOKI_REVIEW_TOOL_GUARD"] = savedGuard;
      if (savedAllow === undefined) delete process.env["LOKI_REVIEW_ALLOWLIST"];
      else process.env["LOKI_REVIEW_ALLOWLIST"] = savedAllow;
    }
  });

  it("OPT OUT: no --allowedTools when LOKI_REVIEW_ALLOWLIST=0 (escape hatch); denylist still present", async () => {
    _resetClaudeHelpCacheForTest(HELP_FULL);
    const savedGuard = process.env["LOKI_REVIEW_TOOL_GUARD"];
    const savedAllow = process.env["LOKI_REVIEW_ALLOWLIST"];
    delete process.env["LOKI_REVIEW_TOOL_GUARD"]; // denylist default-on
    process.env["LOKI_REVIEW_ALLOWLIST"] = "0"; // escape hatch
    const cap = { argv: [] as string[] };
    try {
      await dispatchClaudeAgents(fakeCtx(), capturingRunner(cap));
      expect(cap.argv.includes("--allowedTools")).toBe(false);
      expect(cap.argv.includes("--disallowedTools")).toBe(true);
      expect(cap.argv[cap.argv.length - 2]).toBe("-p");
    } finally {
      if (savedGuard === undefined) delete process.env["LOKI_REVIEW_TOOL_GUARD"];
      else process.env["LOKI_REVIEW_TOOL_GUARD"] = savedGuard;
      if (savedAllow === undefined) delete process.env["LOKI_REVIEW_ALLOWLIST"];
      else process.env["LOKI_REVIEW_ALLOWLIST"] = savedAllow;
    }
  });

  it("ON: adds --allowedTools with read/inspect token (and keeps the denylist) when =1 and supported", async () => {
    _resetClaudeHelpCacheForTest(HELP_FULL);
    const savedGuard = process.env["LOKI_REVIEW_TOOL_GUARD"];
    const savedAllow = process.env["LOKI_REVIEW_ALLOWLIST"];
    delete process.env["LOKI_REVIEW_TOOL_GUARD"];
    process.env["LOKI_REVIEW_ALLOWLIST"] = "1";
    const cap = { argv: [] as string[] };
    try {
      await dispatchClaudeAgents(fakeCtx(), capturingRunner(cap));
      const idx = cap.argv.indexOf("--allowedTools");
      expect(idx).toBeGreaterThanOrEqual(0);
      const allowList = cap.argv[idx + 1] ?? "";
      expect(allowList).toContain("Read");
      expect(allowList).toContain("Grep");
      expect(allowList).toContain("Glob");
      expect(allowList).toContain("Bash(git diff:*)");
      // No mutators in the ALLOW grant.
      expect(allowList).not.toContain("Edit");
      expect(allowList).not.toContain("Write");
      expect(allowList).not.toContain("git push");
      // Deny precedence is safe (verified live), so denylist coexists.
      expect(cap.argv.includes("--disallowedTools")).toBe(true);
      // The -p prompt stays second-to-last (token never swallows it).
      expect(cap.argv[cap.argv.length - 2]).toBe("-p");
    } finally {
      if (savedGuard === undefined) delete process.env["LOKI_REVIEW_TOOL_GUARD"];
      else process.env["LOKI_REVIEW_TOOL_GUARD"] = savedGuard;
      if (savedAllow === undefined) delete process.env["LOKI_REVIEW_ALLOWLIST"];
      else process.env["LOKI_REVIEW_ALLOWLIST"] = savedAllow;
    }
  });

  it("graceful degrade: =1 but CLI lacks --allowedTools -> no flag emitted, voter still works", async () => {
    _resetClaudeHelpCacheForTest("  --agents\n  --json-schema\n  --disallowedTools <tools...>");
    const savedGuard = process.env["LOKI_REVIEW_TOOL_GUARD"];
    const savedAllow = process.env["LOKI_REVIEW_ALLOWLIST"];
    delete process.env["LOKI_REVIEW_TOOL_GUARD"];
    process.env["LOKI_REVIEW_ALLOWLIST"] = "1";
    const cap = { argv: [] as string[] };
    try {
      await dispatchClaudeAgents(fakeCtx(), capturingRunner(cap));
      expect(cap.argv.includes("--allowedTools")).toBe(false);
      expect(cap.argv.includes("--agents")).toBe(true);
      expect(cap.argv[cap.argv.length - 2]).toBe("-p");
    } finally {
      if (savedGuard === undefined) delete process.env["LOKI_REVIEW_TOOL_GUARD"];
      else process.env["LOKI_REVIEW_TOOL_GUARD"] = savedGuard;
      if (savedAllow === undefined) delete process.env["LOKI_REVIEW_ALLOWLIST"];
      else process.env["LOKI_REVIEW_ALLOWLIST"] = savedAllow;
    }
  });
});
