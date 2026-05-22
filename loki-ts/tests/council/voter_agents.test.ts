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
  it("includes the base findings summary in the prompt", () => {
    const baseFindings: AgentVerdict[] = [
      { role: "requirements-verifier", verdict: "APPROVE", reason: "all met", issues: [] },
      { role: "test-auditor", verdict: "APPROVE", reason: "passing", issues: [] },
      { role: "convergence-voter", verdict: "APPROVE", reason: "stable", issues: [] },
    ];
    const da = buildDevilsAdvocateAgent(fakeCtx({ iteration: 11 }), baseFindings);
    expect(da.model).toBe("opus");
    expect(da.effort).toBe("xhigh");
    expect(da.prompt).toContain("iteration 11");
    expect(da.prompt).toContain("devils-advocate");
    for (const f of baseFindings) {
      expect(da.prompt).toContain(f.role);
      expect(da.prompt).toContain(f.reason);
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
