// LOKI_SIMPLE=1 strips COACHING from the prompt prefix and leaves STATE alone.
//
// Byte-mirrored with the bash route (tests/test-simple-prompt-ablation.sh).
// Both must assert the same property or the routes can diverge silently.
//
// WHY THE FLAG EXISTS. Anthropic deleted ~80% of Claude Code's system prompt
// for Opus 5, on the finding that instructions written to correct older models
// had become dead weight -- and that the model measured slightly MORE capable
// without them. Their method was ablation: delete, measure, and add back only
// what a measured failure demands. Nothing in our prefix had been measured.
//
// THE DISTINCTION THIS PINS:
//
//   COACHING (prefix) is how to work -- the RARV cycle, SDLC phases, memory
//   habits. A frontier model does these natively; being told costs attention.
//
//   STATE (tail) is what happened -- which gate failed, what self-heal found.
//   The model cannot derive it. Deleting it deletes the run's memory.
//
// The tail assertion below is the load-bearing one. If a future edit widens
// the strip to swallow gate-failure context, the arm stops being an experiment
// about prompt bloat and becomes an experiment about running blind.
//
// Gates, receipts and verification are never an ablation arm.
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildPrompt } from "../src/runner/build_prompt";

describe("LOKI_SIMPLE prompt ablation", () => {
  let workDir = "";

  beforeEach(() => {
    workDir = mkdtempSync(resolve(tmpdir(), "loki-simple-"));
    mkdirSync(resolve(workDir, ".loki/quality"), { recursive: true });
    // Drive the REAL gate-failure path rather than assigning a variable: the
    // builder rebuilds this context from the file on every call.
    writeFileSync(
      resolve(workDir, ".loki/quality/gate-failures.txt"),
      "mock_integrity FAILED on iteration 3\n",
    );
  });

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  const emit = (simple: string) =>
    buildPrompt({
      retry: 0,
      prd: null,
      iteration: 1,
      ctx: {
        cwd: workDir,
        env: {
          TARGET_DIR: workDir,
          MAX_PARALLEL_AGENTS: "10",
          AUTONOMY_MODE: "standard",
          LOKI_SIMPLE: simple,
        },
      },
    });

  it("strips coaching but keeps the task anchor", async () => {
    const full = await emit("0");
    const simple = await emit("1");

    // Vacuity guard: "absent" is trivially true of an empty string, so the
    // default arm must actually carry the coaching before its absence means
    // anything at all.
    expect(full).toContain("RALPH WIGGUM MODE ACTIVE");
    expect(full).toContain("SDLC_PHASES_ENABLED");

    expect(simple).not.toContain("RALPH WIGGUM MODE ACTIVE");
    expect(simple).not.toContain("SDLC_PHASES_ENABLED");

    // The one thing the model cannot infer. Stripping it would not be
    // ablation, it would be deleting the question.
    expect(simple).toContain("Loki Mode");
    expect(simple).toContain("<loki_system>");
    expect(simple).toContain("[CACHE_BREAKPOINT]");
  });

  it("never strips gate-failure STATE", async () => {
    const full = await emit("0");
    const simple = await emit("1");

    // Guard against a vacuous pass: if the fixture never reached the default
    // arm, "it survived the strip" would prove nothing.
    expect(full).toContain("mock_integrity FAILED on iteration 3");
    expect(simple).toContain("mock_integrity FAILED on iteration 3");
  });

  it("leaves the default arm byte-identical", async () => {
    // Default-off is what keeps all 61 build_prompt parity fixtures valid.
    // An unset var and an explicit "0" must produce the same bytes.
    const unset = await buildPrompt({
      retry: 0,
      prd: null,
      iteration: 1,
      ctx: {
        cwd: workDir,
        env: {
          TARGET_DIR: workDir,
          MAX_PARALLEL_AGENTS: "10",
          AUTONOMY_MODE: "standard",
        },
      },
    });
    expect(unset).toBe(await emit("0"));
  });

  it("measurably shrinks the prompt", async () => {
    const full = await emit("0");
    const simple = await emit("1");
    expect(simple.length).toBeLessThan(full.length);
    const pct = Math.round((100 * (full.length - simple.length)) / full.length);
    // Bounded assertion, not a bare "smaller": a one-byte shrink would pass
    // that while proving the ablation did essentially nothing.
    expect(pct).toBeGreaterThan(50);
    console.log(
      `LOKI_SIMPLE: ${full.length} -> ${simple.length} bytes (-${pct}%), ` +
        `~${Math.round((full.length - simple.length) / 4)} tokens/iteration`,
    );
  });
});
