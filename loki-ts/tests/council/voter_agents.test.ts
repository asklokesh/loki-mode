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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { validateFinding } from "../../src/council/finding_schema.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildVoterAgentsJson,
  buildDevilsAdvocateAgent,
  dispatchClaudeAgents,
  dispatchDevilsAdvocate,
  citationCtx,
  VOTER_SLUGS,
  type ClaudeRunner,
} from "../../src/council/voter_agents.ts";
import { recordFromClaudeResult, recordFromUsage, withChildLedger } from "../../src/util/child_ledger.ts";
import { __resetSdkClientForTests } from "../../src/runner/sdk_invoker.ts";
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
    }
  });

  it("Cost S7: haiku with no effort unless complexity=complex, which keeps opus/sonnet", () => {
    const prev = process.env["LOKI_COMPLEXITY"];
    try {
      delete process.env["LOKI_COMPLEXITY"];
      const lean = buildVoterAgentsJson(fakeCtx());
      for (const a of Object.values(lean)) {
        expect(a.model).toBe("haiku");
        expect(a.effort).toBeUndefined();
      }
      process.env["LOKI_COMPLEXITY"] = "complex";
      const cx = buildVoterAgentsJson(fakeCtx());
      expect(cx[VOTER_SLUGS.REQUIREMENTS_VERIFIER]!.model).toBe("opus");
      expect(cx[VOTER_SLUGS.TEST_AUDITOR]!.model).toBe("sonnet");
      expect(cx[VOTER_SLUGS.CONVERGENCE_VOTER]!.model).toBe("sonnet");
      expect(typeof cx[VOTER_SLUGS.TEST_AUDITOR]!.effort).toBe("string");
    } finally {
      if (prev === undefined) delete process.env["LOKI_COMPLEXITY"];
      else process.env["LOKI_COMPLEXITY"] = prev;
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

// COST-WALL: every provider child session appends exactly one line to .loki/metrics/child-sessions.jsonl.
describe("COST-WALL child-session ledger", () => {
  const voters = JSON.stringify({
    findings: [VOTER_SLUGS.REQUIREMENTS_VERIFIER, VOTER_SLUGS.TEST_AUDITOR, VOTER_SLUGS.CONVERGENCE_VOTER].map((role) => ({ role, vote: "APPROVE", reason: "ok", confidence: 0.9 })),
  });
  const ledgerLines = (dir: string): Record<string, unknown>[] => {
    try { return readFileSync(join(dir, "metrics", "child-sessions.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  const ctxIn = (dir: string): CouncilEvaluateContext => { const c = fakeCtx(); return { ...c, ctx: { ...c.ctx, lokiDir: dir } }; };

  it("a real council spawn (fake claude binary on PATH) writes exactly one unmeasured ledger line, never a zero usd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-cw-bin-")), loki = join(dir, ".loki"), bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), `#!/bin/sh\ncase "$1" in --help) echo "  --agents  --json-schema"; exit 0;; esac\nprintf '%s' '${voters}'\n`, { mode: 0o755 });
    const savedPath = process.env["PATH"], savedSdk = process.env["LOKI_SDK_VOTER_AGENTS"];
    process.env["PATH"] = `${bin}:${savedPath}`; delete process.env["LOKI_SDK_VOTER_AGENTS"];
    _resetClaudeHelpCacheForTest();
    try {
      const out = await dispatchClaudeAgents(ctxIn(loki));
      expect(out.length).toBe(3);
      const lines = ledgerLines(loki);
      expect(lines.length).toBe(1);
      expect(lines[0]!["phase"]).toBe("council");
      expect(lines[0]!["cost_status"]).toBe("unmeasured");
      expect("usd" in lines[0]!).toBe(false);
    } finally {
      process.env["PATH"] = savedPath; if (savedSdk !== undefined) process.env["LOKI_SDK_VOTER_AGENTS"] = savedSdk;
      _resetClaudeHelpCacheForTest(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it("COST-WALL-c: the devil's-advocate real spawn also leaves exactly one council ledger line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-cwc-da-")), loki = join(dir, ".loki"), bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), `#!/bin/sh\ncase "$1" in --help) echo "  --agents  --json-schema"; exit 0;; esac\nprintf '%s' 'not a verdict'\n`, { mode: 0o755 });
    const savedPath = process.env["PATH"], savedSdk = process.env["LOKI_SDK_VOTER_AGENTS"];
    process.env["PATH"] = `${bin}:${savedPath}`; delete process.env["LOKI_SDK_VOTER_AGENTS"];
    _resetClaudeHelpCacheForTest();
    try {
      await dispatchDevilsAdvocate(ctxIn(loki)).catch(() => undefined);
      const lines = ledgerLines(loki);
      expect(lines.length).toBe(1);
      expect(lines[0]!["phase"]).toBe("council");
    } finally {
      process.env["PATH"] = savedPath; if (savedSdk !== undefined) process.env["LOKI_SDK_VOTER_AGENTS"] = savedSdk;
      _resetClaudeHelpCacheForTest(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it("COST-WALL-c: the SDK voter path (LOKI_SDK_VOTER_AGENTS=1) passes its ledger to judgeJson", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-cwc-sdkv-")), loki = join(dir, ".loki"), bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), `#!/bin/sh\ncase "$1" in --help) echo "  --agents  --json-schema"; exit 0;; esac\nexit 1\n`, { mode: 0o755 });
    const body = JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-4-5", stop_reason: "end_turn", content: [{ type: "text", text: voters }], usage: { input_tokens: 1000, output_tokens: 500 } });
    const srv = Bun.serve({ port: 0, fetch: () => new Response(body, { headers: { "content-type": "application/json" } }) });
    const keys = ["PATH", "LOKI_SDK_VOTER_AGENTS", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;
    const savedEnv: Record<string, string | undefined> = {};
    for (const k of keys) savedEnv[k] = process.env[k];
    process.env["PATH"] = `${bin}:${savedEnv["PATH"]}`; process.env["LOKI_SDK_VOTER_AGENTS"] = "1";
    process.env["ANTHROPIC_API_KEY"] = "sk-test"; process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${srv.port}`;
    __resetSdkClientForTests(); _resetClaudeHelpCacheForTest();
    try {
      await dispatchClaudeAgents(ctxIn(loki)).catch(() => undefined);
      const lines = ledgerLines(loki);
      expect(lines.length).toBe(1);
      expect(lines[0]!["phase"]).toBe("council");
      expect(lines[0]!["source"]).toBe("sdk-judge");
    } finally {
      srv.stop(true);
      for (const k of keys) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
      __resetSdkClientForTests(); _resetClaudeHelpCacheForTest(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it("negative review timeout falls back to 600s and the SDK vote still lands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-neg-to-")), loki = join(dir, ".loki"), bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), `#!/bin/sh\ncase "$1" in --help) echo "  --agents  --json-schema"; exit 0;; esac\nexit 1\n`, { mode: 0o755 });
    const body = JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-4-5", stop_reason: "end_turn", content: [{ type: "text", text: voters }], usage: { input_tokens: 1000, output_tokens: 500 } });
    const srv = Bun.serve({ port: 0, fetch: () => new Response(body, { headers: { "content-type": "application/json" } }) });
    const keys = ["PATH", "LOKI_SDK_VOTER_AGENTS", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "LOKI_COUNCIL_REVIEW_TIMEOUT"] as const;
    const savedEnv: Record<string, string | undefined> = {};
    for (const k of keys) savedEnv[k] = process.env[k];
    process.env["PATH"] = `${bin}:${savedEnv["PATH"]}`; process.env["LOKI_SDK_VOTER_AGENTS"] = "1";
    process.env["ANTHROPIC_API_KEY"] = "sk-test"; process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${srv.port}`;
    process.env["LOKI_COUNCIL_REVIEW_TIMEOUT"] = "-5";
    __resetSdkClientForTests(); _resetClaudeHelpCacheForTest();
    try {
      await dispatchClaudeAgents(ctxIn(loki)).catch(() => undefined);
      const lines = ledgerLines(loki);
      expect(lines.length).toBe(1);
      expect(lines[0]!["source"]).toBe("sdk-judge");
    } finally {
      srv.stop(true);
      for (const k of keys) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
      __resetSdkClientForTests(); _resetClaudeHelpCacheForTest(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an injected runner (tests) never touches the ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-cw-inj-"));
    try {
      await dispatchClaudeAgents(ctxIn(dir), async () => ({ stdout: voters, exitCode: 0 }));
      expect(ledgerLines(dir).length).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("withChildLedger: result JSON total_cost_usd is recorded as usd; a throwing child still leaves one unmeasured line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-cw-wrap-"));
    try {
      const ok = withChildLedger(async () => ({ stdout: JSON.stringify({ type: "result", total_cost_usd: 0.065, usage: { input_tokens: 3, output_tokens: 4 }, modelUsage: { "claude-sonnet-x": {} } }), exitCode: 0 }), dir, "wall");
      await ok();
      const bad = withChildLedger(async (): Promise<{ stdout: string }> => { throw new Error("boom"); }, dir, "wall");
      await expect(bad()).rejects.toThrow("boom");
      const lines = ledgerLines(dir);
      expect(lines.length).toBe(2);
      expect(lines[0]).toMatchObject({ phase: "wall", model: "claude-sonnet-x", usd: 0.065, input_tokens: 3, output_tokens: 4, source: "ts-spawn" });
      expect(lines[1]!["cost_status"]).toBe("unmeasured");
      expect("usd" in lines[1]!).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("tokens without total_cost_usd are priced by the shared table; usage-free results are unmeasured", () => {
    const priced = recordFromClaudeResult("grill", { type: "result", usage: { input_tokens: 1_000_000 }, modelUsage: { sonnet: {} } })!;
    expect(priced.usd).toBeGreaterThan(0);
    expect(priced.source).toBe("claude-json+priced");
    expect(recordFromClaudeResult("grill", { type: "result" })!.cost_status).toBe("unmeasured");
    expect(recordFromClaudeResult("grill", "not an object")).toBeNull();
    expect(recordFromUsage("council", "sonnet", { input_tokens: 10, output_tokens: 5 }).usd).toBeGreaterThan(0);
    expect(recordFromUsage("council", "sonnet", null).cost_status).toBe("unmeasured");
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
      expect(cap.argv.filter((a) => a === "--disallowedTools")).toHaveLength(1); // merged, never a second flag
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
      expect(cap.argv.join(" ")).not.toContain("Bash(git reset:*)"); // the permission denies may remain; the review guard list must not
      expect(cap.argv.filter((a) => a === "--disallowedTools").length).toBeLessThanOrEqual(1);
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
      expect(cap.argv.join(" ")).not.toContain("Bash(git reset:*)"); // the permission denies may remain; the review guard list must not
      expect(cap.argv.filter((a) => a === "--disallowedTools").length).toBeLessThanOrEqual(1);
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

describe("citationCtx from a monorepo subdirectory", () => {
  it("a shrunk pkg/src/a.ts cited as cwd-relative src/a.ts past EOF stays HIGH", () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), "loki-citctx-")));
    try {
      const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: top, stdio: "ignore" });
      git("init", "-q", "-b", "main");
      mkdirSync(join(top, "pkg", "src"), { recursive: true });
      writeFileSync(join(top, "pkg", "src", "a.ts"), Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n") + "\n");
      git("add", "."); git("commit", "-q", "-m", "base");
      git("checkout", "-q", "-b", "work");
      writeFileSync(join(top, "pkg", "src", "a.ts"), "l0\nl1\n");
      git("commit", "-q", "-am", "shrink");
      const ctx = citationCtx(join(top, "pkg"));
      expect(ctx.root).toBe(top);
      expect(ctx.diffFiles).toEqual(["pkg/src/a.ts"]);
      const f = { role: "c", vote: "REJECT", reason: "r", confidence: 0.9, issues: [{ severity: "HIGH", description: "deleted guard at src/a.ts:15 removes auth" }] };
      const r: any = validateFinding(f, ctx);
      expect(r.issues[0].severity).toBe("HIGH");
    } finally { rmSync(top, { recursive: true, force: true }); }
  });

  it("a shrunk file inside a submodule (diff lists only the gitlink) cited from superproject pkg/ stays HIGH", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "loki-citsub-")));
    try {
      const run = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...a], { cwd, stdio: "ignore" });
      const sub = join(dir, "subrepo"), top = join(dir, "top");
      mkdirSync(sub); mkdirSync(top);
      run(sub, "init", "-q", "-b", "main");
      writeFileSync(join(sub, "s.ts"), Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n") + "\n");
      run(sub, "add", "."); run(sub, "commit", "-q", "-m", "s1");
      run(top, "init", "-q", "-b", "main");
      mkdirSync(join(top, "pkg"));
      run(top, "submodule", "add", "-q", sub, "pkg/sub");
      run(top, "commit", "-q", "-m", "base");
      run(top, "checkout", "-q", "-b", "work");
      const inSub = join(top, "pkg", "sub");
      writeFileSync(join(inSub, "s.ts"), "l0\n");
      run(inSub, "commit", "-q", "-am", "shrink");
      run(top, "commit", "-q", "-am", "bump submodule");
      const ctx = citationCtx(join(top, "pkg"));
      expect(ctx.diffFiles).toEqual(["pkg/sub"]);
      expect(ctx.gitlinks).toEqual(["pkg/sub"]); // mode 160000 from git diff --raw, not a disk guess
      const f = { role: "c", vote: "REJECT", reason: "r", confidence: 0.9, issues: [{ severity: "HIGH", description: "deleted guard at sub/s.ts:15 removes auth" }] };
      expect((validateFinding(f, ctx) as any).issues[0].severity).toBe("HIGH");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a deleted file inside a submodule (diff lists only the gitlink) cited from superproject pkg/ stays HIGH", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "loki-citsub-")));
    try {
      const run = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...a], { cwd, stdio: "ignore" });
      const sub = join(dir, "subrepo"), top = join(dir, "top");
      mkdirSync(sub); mkdirSync(top);
      run(sub, "init", "-q", "-b", "main");
      writeFileSync(join(sub, "s.ts"), Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n") + "\n");
      run(sub, "add", "."); run(sub, "commit", "-q", "-m", "s1");
      run(top, "init", "-q", "-b", "main");
      mkdirSync(join(top, "pkg"));
      run(top, "submodule", "add", "-q", sub, "pkg/sub");
      run(top, "commit", "-q", "-m", "base");
      run(top, "checkout", "-q", "-b", "work");
      const inSub = join(top, "pkg", "sub");
      run(inSub, "rm", "-q", "s.ts");
      run(inSub, "commit", "-q", "-m", "delete");
      run(top, "commit", "-q", "-am", "bump submodule");
      const ctx = citationCtx(join(top, "pkg"));
      expect(ctx.diffFiles).toEqual(["pkg/sub"]);
      const f = { role: "c", vote: "REJECT", reason: "r", confidence: 0.9, issues: [{ severity: "HIGH", description: "deleted guard at sub/s.ts:15 removes auth" }] };
      expect((validateFinding(f, ctx) as any).issues[0].severity).toBe("HIGH");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  describe("citationCtx gitlinks come from the mode in git diff --raw", () => {
    const fixture = (mutate: (run: (cwd: string, ...a: string[]) => void, top: string, sub: string) => void) => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "loki-gitlink-")));
      const run = (cwd: string, ...a: string[]) => { execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...a], { cwd, stdio: "ignore" }); };
      const sub = join(dir, "subrepo"), top = join(dir, "top");
      mkdirSync(sub); mkdirSync(top);
      run(sub, "init", "-q", "-b", "main");
      writeFileSync(join(sub, "s.ts"), "l0\n"); run(sub, "add", "."); run(sub, "commit", "-q", "-m", "s1");
      run(top, "init", "-q", "-b", "main");
      mkdirSync(join(top, "src")); writeFileSync(join(top, "src", "real.ts"), "a\n");
      mutate(run, top, sub);
      return { dir, top };
    };

    it("a bumped gitlink plus a plain file: only the gitlink is listed", () => {
      const { dir, top } = fixture((run, top, sub) => {
        run(top, "submodule", "add", "-q", sub, "pkg/sub"); run(top, "add", "."); run(top, "commit", "-q", "-m", "base");
        run(top, "checkout", "-q", "-b", "work");
        writeFileSync(join(sub, "s.ts"), "l1\n"); run(sub, "commit", "-q", "-am", "s2");
        run(join(top, "pkg", "sub"), "pull", "-q", "origin", "main");
        mkdirSync(join(top, "pkg"), { recursive: true }); writeFileSync(join(top, "pkg", "real.ts"), "b\n");
        run(top, "add", "."); run(top, "commit", "-q", "-m", "bump and edit");
      });
      try {
        const ctx = citationCtx(top);
        expect([...(ctx.diffFiles ?? [])].sort()).toEqual(["pkg/real.ts", "pkg/sub"]);
        expect(ctx.gitlinks).toEqual(["pkg/sub"]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("a deleted gitlink (mode on the old side only) is listed", () => {
      const { dir, top } = fixture((run, top, sub) => {
        run(top, "submodule", "add", "-q", sub, "pkg/sub"); run(top, "add", "."); run(top, "commit", "-q", "-m", "base");
        run(top, "checkout", "-q", "-b", "work");
        run(top, "rm", "-q", "-f", "pkg/sub"); run(top, "commit", "-q", "-m", "drop submodule");
      });
      try { expect(citationCtx(top).gitlinks).toEqual(["pkg/sub"]); } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("an added gitlink (mode on the new side only) is listed", () => {
      const { dir, top } = fixture((run, top, sub) => {
        run(top, "add", "."); run(top, "commit", "-q", "-m", "base");
        run(top, "checkout", "-q", "-b", "work");
        run(top, "submodule", "add", "-q", sub, "pkg/sub"); run(top, "commit", "-q", "-m", "add submodule");
      });
      try { expect(citationCtx(top).gitlinks).toEqual(["pkg/sub"]); } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });
});
