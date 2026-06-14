// Per-section unit tests for build_prompt.ts. Exercises the non-fixture
// code paths: PHASE_X flag matrix, queue truncation to 3, ledger and handoff
// readers, gate-failure injection, RARV instruction generation, BMAD/MiroFish.
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { _internals, buildPrompt } from "../../src/runner/build_prompt.ts";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(resolve(tmpdir(), "loki-bp-test-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function mkLoki(...segs: string[]): string {
  const dir = resolve(workDir, ".loki", ...segs);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function emptyEnv(over: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    PHASE_UNIT_TESTS: "false",
    PHASE_API_TESTS: "false",
    PHASE_E2E_TESTS: "false",
    PHASE_SECURITY: "false",
    PHASE_INTEGRATION: "false",
    PHASE_CODE_REVIEW: "false",
    PHASE_WEB_RESEARCH: "false",
    PHASE_PERFORMANCE: "false",
    PHASE_ACCESSIBILITY: "false",
    PHASE_REGRESSION: "false",
    PHASE_UAT: "false",
    MAX_PARALLEL_AGENTS: "10",
    MAX_ITERATIONS: "1000",
    AUTONOMY_MODE: "",
    PERPETUAL_MODE: "false",
    PROVIDER_DEGRADED: "false",
    LOKI_LEGACY_PROMPT_ORDERING: "false",
    COMPLETION_PROMISE: "",
    LOKI_HUMAN_INPUT: "",
    TARGET_DIR: ".",
    ...over,
  };
}

describe("buildPhases (PHASE_X flag matrix)", () => {
  it("returns empty when no PHASE_* vars are true", () => {
    expect(_internals.buildPhases({})).toBe("");
    expect(_internals.buildPhases({ PHASE_UNIT_TESTS: "false" })).toBe("");
  });
  it("preserves canonical order across all 11 phases", () => {
    const env: Record<string, string> = {
      PHASE_UAT: "true",
      PHASE_UNIT_TESTS: "true",
      PHASE_API_TESTS: "true",
      PHASE_E2E_TESTS: "true",
      PHASE_SECURITY: "true",
      PHASE_INTEGRATION: "true",
      PHASE_CODE_REVIEW: "true",
      PHASE_WEB_RESEARCH: "true",
      PHASE_PERFORMANCE: "true",
      PHASE_ACCESSIBILITY: "true",
      PHASE_REGRESSION: "true",
    };
    expect(_internals.buildPhases(env)).toBe(
      "UNIT_TESTS,API_TESTS,E2E_TESTS,SECURITY,INTEGRATION,CODE_REVIEW,WEB_RESEARCH,PERFORMANCE,ACCESSIBILITY,REGRESSION,UAT",
    );
  });
  it("ignores values that are not exactly 'true'", () => {
    expect(_internals.buildPhases({ PHASE_UNIT_TESTS: "1", PHASE_API_TESTS: "yes" })).toBe("");
  });
});

describe("rarvInstruction", () => {
  it("interpolates MAX_PARALLEL_AGENTS", () => {
    const s = _internals.rarvInstruction(7);
    expect(s).toContain("MAX_PARALLEL_AGENTS=7");
    expect(s).toMatch(/^RALPH WIGGUM MODE ACTIVE\./);
    expect(s.endsWith("test, or feature.")).toBe(true);
  });
});

describe("completionInstruction", () => {
  it("uses promise text when set", () => {
    const s = _internals.completionInstruction("ship v1.0", 5, 100);
    expect(s.startsWith("COMPLETION_PROMISE: [ship v1.0]")).toBe(true);
  });
  it("uses iteration/max when promise empty", () => {
    const s = _internals.completionInstruction("", 7, 99);
    expect(s).toContain("Iteration 7 of max 99");
    expect(s.startsWith("NO COMPLETION PROMISE SET")).toBe(true);
  });
});

describe("autonomousSuffix", () => {
  it("emits perpetual rules when perpetual=true", () => {
    expect(_internals.autonomousSuffix(true, "")).toContain("Work continues PERPETUALLY");
  });
  it("emits standard rules when perpetual=false", () => {
    const s = _internals.autonomousSuffix(false, "promise-x");
    expect(s).toContain("completion_statement='promise-x'");
  });
});

describe("loadQueueTasks", () => {
  it("returns empty when neither queue file exists", () => {
    expect(_internals.loadQueueTasks(workDir)).toBe("");
  });

  it("truncates to first 3 tasks (PRD source, rich format)", () => {
    mkLoki("queue");
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      id: `prd-${i + 1}`,
      source: "prd",
      title: `Title ${i + 1}`,
      description: `Desc ${i + 1}`,
      acceptance_criteria: [`crit-${i + 1}-a`, `crit-${i + 1}-b`],
      user_story: `story ${i + 1}`,
    }));
    writeFileSync(resolve(workDir, ".loki/queue/pending.json"), JSON.stringify(tasks));
    const out = _internals.loadQueueTasks(workDir);
    expect(out).toContain("PENDING[1] prd-1");
    expect(out).toContain("PENDING[2] prd-2");
    expect(out).toContain("PENDING[3] prd-3");
    expect(out).not.toContain("prd-4");
    expect(out).not.toContain("prd-5");
  });

  it("formats legacy tasks via type+payload.action", () => {
    mkLoki("queue");
    writeFileSync(
      resolve(workDir, ".loki/queue/pending.json"),
      JSON.stringify([{ id: "t-1", type: "refactor", payload: { action: "split module" } }]),
    );
    const out = _internals.loadQueueTasks(workDir);
    expect(out).toContain("PENDING[1] id=t-1 type=refactor: split module");
  });

  it("emits IN-PROGRESS header when in-progress.json exists", () => {
    mkLoki("queue");
    writeFileSync(
      resolve(workDir, ".loki/queue/in-progress.json"),
      JSON.stringify([{ id: "prd-x", source: "prd", title: "Active" }]),
    );
    const out = _internals.loadQueueTasks(workDir);
    expect(out).toContain("IN-PROGRESS TASKS (EXECUTE THESE):");
    expect(out).toContain("TASK[1] prd-x: Active");
  });

  it("supports {tasks: [...]} object form", () => {
    mkLoki("queue");
    writeFileSync(
      resolve(workDir, ".loki/queue/pending.json"),
      JSON.stringify({ tasks: [{ id: "prd-z", source: "prd", title: "OnlyOne" }] }),
    );
    expect(_internals.loadQueueTasks(workDir)).toContain("PENDING[1] prd-z: OnlyOne");
  });
});

describe("loadLedgerContext", () => {
  it("returns empty when ledgers dir absent", () => {
    expect(_internals.loadLedgerContext(workDir)).toBe("");
  });

  it("picks newest LEDGER-*.md and head -100 lines", () => {
    const dir = mkLoki("memory/ledgers");
    const oldFile = resolve(dir, "LEDGER-A.md");
    const newFile = resolve(dir, "LEDGER-B.md");
    writeFileSync(oldFile, "OLD\n");
    writeFileSync(newFile, "NEW LEDGER\n");
    // Force B's mtime newer than A.
    const future = new Date(Date.now() + 10_000);
    utimesSync(newFile, future, future);
    expect(_internals.loadLedgerContext(workDir)).toContain("NEW LEDGER");
  });

  it("respects 100-line truncation", () => {
    const dir = mkLoki("memory/ledgers");
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");
    writeFileSync(resolve(dir, "LEDGER-X.md"), lines + "\n");
    const out = _internals.loadLedgerContext(workDir);
    const got = out.split("\n");
    expect(got.length).toBeLessThanOrEqual(100);
    expect(got[0]).toBe("line-0");
    expect(got[99]).toBe("line-99");
  });
});

describe("loadHandoffContext", () => {
  it("returns empty when no handoffs", async () => {
    expect(await _internals.loadHandoffContext(workDir)).toBe("");
  });

  it("formats JSON handoff with all fields", async () => {
    const dir = mkLoki("memory/handoffs");
    writeFileSync(
      resolve(dir, "20260101-000000.json"),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00Z",
        reason: "ctx_clear",
        iteration: 9,
        files_modified: ["a.ts", "b.ts"],
        task_status: { pending: 2, completed: 1 },
        open_questions: ["why?"],
        blockers: ["redis is down"],
      }),
    );
    const out = await _internals.loadHandoffContext(workDir);
    expect(out).toContain("Handoff from 2026-01-01T00:00:00Z (reason: ctx_clear)");
    expect(out).toContain("Iteration: 9");
    expect(out).toContain("Modified files: a.ts, b.ts");
    expect(out).toContain("Tasks - pending: 2, completed: 1");
    expect(out).toContain("Open question: why?");
    expect(out).toContain("Blocker: redis is down");
  });

  it("falls back to .md (head -80 lines) when no .json", async () => {
    const dir = mkLoki("memory/handoffs");
    const lines = Array.from({ length: 120 }, (_, i) => `note-${i}`).join("\n");
    writeFileSync(resolve(dir, "old.md"), lines + "\n");
    const out = await _internals.loadHandoffContext(workDir);
    const arr = out.split("\n");
    expect(arr.length).toBeLessThanOrEqual(80);
    expect(arr[0]).toBe("note-0");
  });
});

describe("buildGateFailureContext", () => {
  it("returns empty when gate-failures.txt absent", async () => {
    expect(await _internals.buildGateFailureContext(workDir)).toBe("");
  });

  it("injects failures + static-analysis + tests sidecars", async () => {
    mkLoki("quality");
    writeFileSync(resolve(workDir, ".loki/quality/gate-failures.txt"), "ERR-1: TypeError\n");
    writeFileSync(
      resolve(workDir, ".loki/quality/static-analysis.json"),
      JSON.stringify({ summary: "5 errors" }),
    );
    writeFileSync(
      resolve(workDir, ".loki/quality/test-results.json"),
      JSON.stringify({ summary: "3 failed" }),
    );
    const out = await _internals.buildGateFailureContext(workDir);
    expect(out).toContain("QUALITY GATE FAILURES FROM PREVIOUS ITERATION: [ERR-1: TypeError]. ");
    expect(out).toContain("Static analysis: 5 errors. ");
    expect(out).toContain("Tests: 3 failed. ");
    expect(out.endsWith("FIX THESE ISSUES BEFORE PROCEEDING WITH NEW WORK.")).toBe(true);
  });
});

describe("buildAppRunnerInfo", () => {
  it("emits APP_RUNNING_AT for running state", () => {
    mkLoki("app-runner");
    writeFileSync(
      resolve(workDir, ".loki/app-runner/state.json"),
      JSON.stringify({ status: "running", url: "http://x", method: "npm start" }),
    );
    expect(_internals.buildAppRunnerInfo(workDir)).toBe(
      "APP_RUNNING_AT: http://x (auto-restarts on code changes). Method: npm start",
    );
  });
  it("emits APP_CRASHED for crashed state", () => {
    mkLoki("app-runner");
    writeFileSync(
      resolve(workDir, ".loki/app-runner/state.json"),
      JSON.stringify({ status: "crashed", crash_count: 7 }),
    );
    expect(_internals.buildAppRunnerInfo(workDir)).toContain("crashed 7 times");
  });
});

describe("buildPlaywrightInfo", () => {
  it("PASSED when passed=true", () => {
    mkLoki("verification");
    writeFileSync(
      resolve(workDir, ".loki/verification/playwright-results.json"),
      JSON.stringify({ passed: true }),
    );
    expect(_internals.buildPlaywrightInfo(workDir)).toBe(
      "PLAYWRIGHT_SMOKE_TEST: PASSED - App loads correctly.",
    );
  });
  it("FAILED with failing checks + errors", () => {
    mkLoki("verification");
    writeFileSync(
      resolve(workDir, ".loki/verification/playwright-results.json"),
      JSON.stringify({
        passed: false,
        checks: { loads: true, no_console_errors: false, title: false },
        errors: ["e1", "e2"],
      }),
    );
    const out = _internals.buildPlaywrightInfo(workDir);
    expect(out).toContain("FAILED - no_console_errors, title");
    expect(out).toContain("Errors: e1; e2");
  });
});

describe("buildBmadContext", () => {
  it("emits empty when bmad-metadata.json missing", () => {
    expect(_internals.buildBmadContext(workDir)).toBe("");
  });
  it("includes architecture / tasks / validation when present", () => {
    mkdirSync(resolve(workDir, ".loki"), { recursive: true });
    writeFileSync(resolve(workDir, ".loki/bmad-metadata.json"), "{}");
    writeFileSync(resolve(workDir, ".loki/bmad-architecture-summary.md"), "ARCH-X");
    writeFileSync(resolve(workDir, ".loki/bmad-tasks.json"), JSON.stringify([{ id: "T1" }]));
    writeFileSync(resolve(workDir, ".loki/bmad-validation.md"), "VAL-Y");
    const out = _internals.buildBmadContext(workDir);
    expect(out).toContain("BMAD_CONTEXT:");
    expect(out).toContain("ARCHITECTURE DECISIONS: ARCH-X");
    // v7.4.6: bash uses python json.dumps default separators (", " and ": "),
    // not JS JSON.stringify's compact `,` `:`. The TS port matches via
    // pythonJsonDumps(); see fixture-42 in parity tests.
    expect(out).toContain('EPIC/STORY TASKS (from BMAD): [{"id": "T1"}]');
    expect(out).toContain("ARTIFACT VALIDATION: VAL-Y");
  });
});

describe("buildOpenspecContext", () => {
  it("returns empty when missing", () => {
    expect(_internals.buildOpenspecContext(workDir)).toBe("");
  });
  it("formats added/modified/removed deltas", () => {
    mkLoki("openspec");
    writeFileSync(
      resolve(workDir, ".loki/openspec/delta-context.json"),
      JSON.stringify({
        deltas: {
          auth: {
            added: [{ name: "AddSession" }],
            modified: [{ name: "RotateKey", previously: "static" }],
            removed: [{ name: "Legacy", reason: "deprecated" }],
          },
        },
        complexity: "high",
      }),
    );
    const out = _internals.buildOpenspecContext(workDir);
    expect(out).toContain("OPENSPEC DELTA CONTEXT:");
    expect(out).toContain("ADDED [auth]: AddSession");
    expect(out).toContain("MODIFIED [auth]: RotateKey");
    expect(out).toContain("REMOVED [auth]: Legacy");
    expect(out).toContain("Complexity: high");
  });
});

describe("buildChecklistStatus", () => {
  it("emits PRD_CHECKLIST_INIT when PRD set and checklist absent", () => {
    const out = _internals.buildChecklistStatus(workDir, "./prd.md", { CHECKLIST_INTERVAL: "11" });
    expect(out).toContain("PRD_CHECKLIST_INIT:");
    expect(out).toContain("auto-verified every 11 iterations");
  });
  it("returns empty when checklist.json exists (no checklist_summary fn)", () => {
    mkLoki("checklist");
    writeFileSync(resolve(workDir, ".loki/checklist/checklist.json"), "{}");
    expect(_internals.buildChecklistStatus(workDir, "./prd.md", {})).toBe("");
  });
});

describe("buildPrompt end-to-end (cold start, no PRD)", () => {
  it("emits static-first layout with analysis instruction", async () => {
    const out = await buildPrompt({
      retry: 0,
      prd: null,
      iteration: 1,
      ctx: { cwd: workDir, env: emptyEnv({ PHASE_UNIT_TESTS: "true" }) },
    });
    expect(out.startsWith("<loki_system>\nLoki Mode\n")).toBe(true);
    expect(out).toContain("CODEBASE_ANALYSIS_MODE:");
    expect(out).toContain("[CACHE_BREAKPOINT]");
    expect(out).toContain('<dynamic_context iteration="1" retry="0">');
    expect(out.endsWith("</dynamic_context>\n")).toBe(true);
  });
});

describe("buildPrompt end-to-end (degraded provider)", () => {
  it("emits minimal coding-assistant prompt for PRD mode", async () => {
    writeFileSync(resolve(workDir, "prd.md"), "# PRD\nbody");
    const out = await buildPrompt({
      retry: 0,
      prd: "./prd.md",
      iteration: 2,
      ctx: { cwd: workDir, env: emptyEnv({ PROVIDER_DEGRADED: "true" }) },
    });
    expect(out).toContain("Loki Mode with PRD");
    expect(out).toContain(
      "You are a coding assistant. Read and implement the requirements from the PRD.",
    );
    expect(out).toContain("PRD contents: # PRD\nbody");
  });
});

describe("buildPrompt end-to-end (legacy ordering)", () => {
  it("emits single-line legacy layout when LOKI_LEGACY_PROMPT_ORDERING=true", async () => {
    const out = await buildPrompt({
      retry: 0,
      prd: "./prd.md",
      iteration: 3,
      ctx: { cwd: workDir, env: emptyEnv({ LOKI_LEGACY_PROMPT_ORDERING: "true" }) },
    });
    expect(out.startsWith("Loki Mode with PRD at ./prd.md.")).toBe(true);
    // Legacy ordering ends with autonomous_suffix + newline; never opens an XML tag.
    expect(out).not.toContain("<loki_system>");
    expect(out).not.toContain("[CACHE_BREAKPOINT]");
  });
});

describe("buildPrompt end-to-end (resume injects ledger/handoff)", () => {
  it("includes PREVIOUS_LEDGER_STATE on retry > 0", async () => {
    const dir = mkLoki("memory/ledgers");
    writeFileSync(resolve(dir, "LEDGER-A.md"), "## Decisions\n- pick-x\n");
    const out = await buildPrompt({
      retry: 1,
      prd: "./prd.md",
      iteration: 4,
      ctx: { cwd: workDir, env: emptyEnv() },
    });
    expect(out).toContain("Resume iteration #4 (retry #1). PRD: ./prd.md");
    expect(out).toContain("PREVIOUS_LEDGER_STATE:");
    expect(out).toContain("pick-x");
  });
});

describe("buildPrompt end-to-end (gate failure injection)", () => {
  it("renders quality gate context section in dynamic tail", async () => {
    mkLoki("quality");
    writeFileSync(resolve(workDir, ".loki/quality/gate-failures.txt"), "BLOCK\n");
    const out = await buildPrompt({
      retry: 0,
      prd: "./prd.md",
      iteration: 9,
      ctx: { cwd: workDir, env: emptyEnv() },
    });
    expect(out).toContain("QUALITY GATE FAILURES FROM PREVIOUS ITERATION: [BLOCK]. ");
    expect(out).toContain("FIX THESE ISSUES BEFORE PROCEEDING WITH NEW WORK.");
  });
});

// v7.40.0 (#584): AUTONOMOUS complexity-gated Claude Code Dynamic Workflow
// dispatch for the READ-ONLY codebase-analysis pass. Decision cascade (same
// order on bash + Bun):
//   provider != claude          -> three-pass
//   PROVIDER_DEGRADED=true       -> three-pass
//   LOKI_USE_CLAUDE_WORKFLOWS=0  -> three-pass (escape hatch)
//   LOKI_USE_CLAUDE_WORKFLOWS=1  -> workflow   (force on)
//   var UNSET                    -> workflow IFF DETECTED_COMPLEXITY == complex
describe("buildPrompt v7.40.0 autonomous complexity-gated ultracode analysis", () => {
  it("default (flag unset, no complexity) produces NO 'ultracode:' prefix", async () => {
    const out = await buildPrompt({
      retry: 0,
      prd: null,
      iteration: 1,
      ctx: { cwd: workDir, env: emptyEnv() },
    });
    expect(out).toContain("CODEBASE_ANALYSIS_MODE:");
    expect(out).not.toContain("ultracode:");
    expect(out).toContain(_internals.ANALYSIS_INSTRUCTION);
    expect(out).not.toContain("ultracode: CODEBASE_ANALYSIS_MODE:");
  });

  it("byte-identical to default for simple/standard + unset var", async () => {
    const baseline = await buildPrompt({
      retry: 0,
      prd: null,
      iteration: 7,
      ctx: { cwd: workDir, env: emptyEnv() },
    });
    for (const cx of ["simple", "standard"]) {
      const out = await buildPrompt({
        retry: 0,
        prd: null,
        iteration: 7,
        ctx: { cwd: workDir, env: emptyEnv({ LOKI_PROVIDER: "claude", DETECTED_COMPLEXITY: cx }) },
      });
      expect(out).toBe(baseline);
    }
  });

  it("byte-identical to default when the flag is explicitly off (escape hatch), even on complex", async () => {
    const baseline = await buildPrompt({
      retry: 0,
      prd: null,
      iteration: 7,
      ctx: { cwd: workDir, env: emptyEnv() },
    });
    const flaggedOff = await buildPrompt({
      retry: 0,
      prd: null,
      iteration: 7,
      ctx: {
        cwd: workDir,
        env: emptyEnv({
          LOKI_USE_CLAUDE_WORKFLOWS: "0",
          LOKI_PROVIDER: "claude",
          DETECTED_COMPLEXITY: "complex",
        }),
      },
    });
    expect(flaggedOff).toBe(baseline);
  });

  it("LOKI_USE_CLAUDE_WORKFLOWS=1 forces 'ultracode:' on (regardless of complexity)", async () => {
    const out = await buildPrompt({
      retry: 0,
      prd: null,
      iteration: 1,
      ctx: {
        cwd: workDir,
        env: emptyEnv({ LOKI_USE_CLAUDE_WORKFLOWS: "1", LOKI_PROVIDER: "claude" }),
      },
    });
    expect(out).toContain("ultracode: CODEBASE_ANALYSIS_MODE:");
    expect(out).toContain("ultracode: " + _internals.ANALYSIS_INSTRUCTION);
  });

  it("var UNSET + DETECTED_COMPLEXITY=complex autonomously prefixes 'ultracode:'", async () => {
    const out = await buildPrompt({
      retry: 0,
      prd: null,
      iteration: 1,
      ctx: {
        cwd: workDir,
        env: emptyEnv({ LOKI_PROVIDER: "claude", DETECTED_COMPLEXITY: "complex" }),
      },
    });
    expect(out).toContain("ultracode: CODEBASE_ANALYSIS_MODE:");
    expect(out).toContain("ultracode: " + _internals.ANALYSIS_INSTRUCTION);
  });

  it("does NOT prefix when provider is not claude (even =1, even complex)", async () => {
    const out = await buildPrompt({
      retry: 0,
      prd: null,
      iteration: 1,
      ctx: {
        cwd: workDir,
        env: emptyEnv({
          LOKI_USE_CLAUDE_WORKFLOWS: "1",
          LOKI_PROVIDER: "codex",
          DETECTED_COMPLEXITY: "complex",
        }),
      },
    });
    expect(out).toContain("CODEBASE_ANALYSIS_MODE:");
    expect(out).not.toContain("ultracode:");
  });

  it("predicate: useClaudeWorkflowsForAnalysis implements the 6-case cascade", () => {
    const f = _internals.useClaudeWorkflowsForAnalysis;
    _internals.resetWorkflowDisclosure();
    // workDir is an empty tmp dir -> detectComplexity classifies it non-complex,
    // so the unset-flag FS-walk fallback resolves to "standard" deterministically.
    // 1. non-claude provider -> false (even forced, even complex)
    expect(f({ LOKI_PROVIDER: "codex", LOKI_USE_CLAUDE_WORKFLOWS: "1" }, workDir)).toBe(false);
    expect(f({ LOKI_PROVIDER: "codex", DETECTED_COMPLEXITY: "complex" }, workDir)).toBe(false);
    // 2. degraded -> false
    expect(
      f(
        { LOKI_PROVIDER: "claude", PROVIDER_DEGRADED: "true", LOKI_USE_CLAUDE_WORKFLOWS: "1" },
        workDir,
      ),
    ).toBe(false);
    // 3. =0 escape hatch -> false (even complex)
    expect(
      f(
        { LOKI_PROVIDER: "claude", LOKI_USE_CLAUDE_WORKFLOWS: "0", DETECTED_COMPLEXITY: "complex" },
        workDir,
      ),
    ).toBe(false);
    // 4. =1 force on -> true (provider defaults to claude; any complexity)
    expect(f({ LOKI_USE_CLAUDE_WORKFLOWS: "1" }, workDir)).toBe(true);
    expect(f({ LOKI_PROVIDER: "claude", LOKI_USE_CLAUDE_WORKFLOWS: "1" }, workDir)).toBe(true);
    // 5. unset + complex (env var injected) -> true (autonomous)
    expect(f({ LOKI_PROVIDER: "claude", DETECTED_COMPLEXITY: "complex" }, workDir)).toBe(true);
    // 6. unset + non-complex env var -> false; unset + no env var + non-complex
    //    target dir (FS-walk fallback) -> false.
    expect(f({ LOKI_PROVIDER: "claude", DETECTED_COMPLEXITY: "simple" }, workDir)).toBe(false);
    expect(f({ LOKI_PROVIDER: "claude", DETECTED_COMPLEXITY: "standard" }, workDir)).toBe(false);
    expect(f({ LOKI_PROVIDER: "claude" }, workDir)).toBe(false);
  });

  it("Bun production path: unset env var FALLS BACK to detectComplexity FS-walk", () => {
    // This is the dual of Finding 1 on the DEFAULT Bun route: run.sh never runs,
    // so DETECTED_COMPLEXITY is absent and the decision MUST still fire via the
    // FS-walk fallback. Build a complex target dir (docker-compose => complex)
    // with NO DETECTED_COMPLEXITY env var and confirm the predicate returns true.
    _internals.resetWorkflowDisclosure();
    const complexDir = mkdtempSync(resolve(tmpdir(), "loki-bp-complex-"));
    try {
      writeFileSync(resolve(complexDir, "docker-compose.yml"), "services:\n  web:\n    image: x\n");
      const f = _internals.useClaudeWorkflowsForAnalysis;
      // No DETECTED_COMPLEXITY in env; provider defaults to claude; flag unset.
      expect(f({ LOKI_PROVIDER: "claude" }, complexDir)).toBe(true);
      // And a sibling simple dir falls back to three-pass.
      const simpleDir = mkdtempSync(resolve(tmpdir(), "loki-bp-simple-"));
      try {
        _internals.resetWorkflowDisclosure();
        writeFileSync(resolve(simpleDir, "index.js"), "console.log(1)\n");
        expect(f({ LOKI_PROVIDER: "claude" }, simpleDir)).toBe(false);
      } finally {
        rmSync(simpleDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(complexDir, { recursive: true, force: true });
      _internals.resetWorkflowDisclosure();
    }
  });

  it("decision: only unset+complex is flagged autonomous (disclosure key)", () => {
    const d = _internals.workflowAnalysisDecision;
    // forced =1 is workflow but NOT autonomous (no disclosure)
    expect(d({ LOKI_PROVIDER: "claude", LOKI_USE_CLAUDE_WORKFLOWS: "1" })).toEqual({
      useWorkflow: true,
      autonomous: false,
    });
    // unset + complex is workflow AND autonomous (disclosure fires)
    expect(d({ LOKI_PROVIDER: "claude", DETECTED_COMPLEXITY: "complex" })).toEqual({
      useWorkflow: true,
      autonomous: true,
    });
    // three-pass is neither
    expect(d({ LOKI_PROVIDER: "claude", DETECTED_COMPLEXITY: "simple" })).toEqual({
      useWorkflow: false,
      autonomous: false,
    });
  });

  it("disclosure fires once on the autonomous-workflow case, to stderr, and NOT on three-pass", () => {
    const orig = console.error;
    const calls: string[] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args.map(String).join(" "));
    };
    try {
      // three-pass (simple): no disclosure
      _internals.resetWorkflowDisclosure();
      _internals.maybeDiscloseWorkflowAnalysis({
        LOKI_PROVIDER: "claude",
        DETECTED_COMPLEXITY: "simple",
      });
      expect(calls.length).toBe(0);

      // forced =1: workflow but not autonomous -> no disclosure
      _internals.maybeDiscloseWorkflowAnalysis({
        LOKI_PROVIDER: "claude",
        LOKI_USE_CLAUDE_WORKFLOWS: "1",
      });
      expect(calls.length).toBe(0);

      // autonomous workflow: discloses once even when called repeatedly
      _internals.resetWorkflowDisclosure();
      const autoEnv = { LOKI_PROVIDER: "claude", DETECTED_COMPLEXITY: "complex" };
      _internals.maybeDiscloseWorkflowAnalysis(autoEnv);
      _internals.maybeDiscloseWorkflowAnalysis(autoEnv);
      _internals.maybeDiscloseWorkflowAnalysis(autoEnv);
      expect(calls.length).toBe(1);
      expect(calls[0]).toContain("complexity=complex");
      expect(calls[0]).toContain("LOKI_USE_CLAUDE_WORKFLOWS=0");
      expect(calls[0]).toContain("cost meaningfully more");
    } finally {
      console.error = orig;
      _internals.resetWorkflowDisclosure();
    }
  });
});
