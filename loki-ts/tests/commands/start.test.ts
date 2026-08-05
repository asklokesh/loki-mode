// v8 Phase 4 Story 5: pure test for the Bun `loki start` arg parser. Proves the
// supported-flag subset maps to RunnerOpts and unsupported flags are REJECTED
// (never silently dropped -- that would be a hidden capability loss under
// LOKI_SDK_LOOP=1). The runAutonomous delegation itself is covered by the
// existing loki_start_e2e.test.ts.
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { parseStartArgs } from "../../src/commands/start.ts";

// E2E-shaped: drives the real loop, which writes state files and spawns
// processes. Bun's 5000ms default is fine idle and NOT fine inside a full CI
// run, where the box is saturated -- tests then fail at exactly ~5000ms and
// WHICH ones fail changes between runs. That is a timeout signature, not a
// defect, and it reads as a regression. 30s is far beyond the honest worst
// case while still catching a genuine hang.
setDefaultTimeout(30_000);

const errs: string[] = [];
const collect = (s: string) => {
  errs.push(s);
};

describe("parseStartArgs (Bun start flag subset)", () => {
  it("no spec -> exit 2", () => {
    errs.length = 0;
    expect(parseStartArgs(["--max-iterations", "3"], collect)).toBe(2);
    expect(errs.join("")).toContain("spec source");
  });

  it("supported flags map to RunnerOpts", () => {
    const r = parseStartArgs(
      ["./prd.md", "--max-iterations", "5", "--budget-limit", "2.50", "--provider", "claude", "--session-model", "development"],
      collect,
    );
    expect(typeof r).not.toBe("number");
    const opts = r as Exclude<typeof r, number>;
    expect(opts.prdPath).toBe("./prd.md");
    expect(opts.maxIterations).toBe(5);
    expect(opts.budgetLimit).toBe(2.5);
    expect(opts.provider).toBe("claude");
    expect(opts.sessionModel).toBe("development");
  });

  it("unsupported flag -> exit 2 with a clear message (no silent drop)", () => {
    errs.length = 0;
    expect(parseStartArgs(["./prd.md", "--resume", "abc"], collect)).toBe(2);
    const msg = errs.join("");
    expect(msg).toContain("--resume is not supported");
    expect(msg).toContain("bash route");
  });

  // --- RUN-25 iter 2: T3(c) reconciled flag surface -----------------------
  it("boolean env-mapping flags set env, not consume a value token", () => {
    const env: Record<string, string> = {};
    const applyEnv = (k: string, v: string) => {
      env[k] = v;
    };
    // --allow-haiku is boolean; the spec must still be found right after it.
    const r = parseStartArgs(["--allow-haiku", "./prd.md"], collect, () => {}, applyEnv);
    const opts = r as Exclude<typeof r, number>;
    expect(opts.prdPath).toBe("./prd.md"); // NOT swallowed as --allow-haiku's value
    expect(env["LOKI_ALLOW_HAIKU"]).toBe("true");
  });

  it("--simple / --complex map to LOKI_COMPLEXITY", () => {
    const env: Record<string, string> = {};
    parseStartArgs(["./prd.md", "--simple"], collect, () => {}, (k, v) => (env[k] = v));
    expect(env["LOKI_COMPLEXITY"]).toBe("simple");
    const env2: Record<string, string> = {};
    parseStartArgs(["./prd.md", "--complex"], collect, () => {}, (k, v) => (env2[k] = v));
    expect(env2["LOKI_COMPLEXITY"]).toBe("complex");
  });

  it("--regen spellings all set LOKI_PRD_REGEN; --skip-memory sets LOKI_SKIP_MEMORY", () => {
    for (const flag of ["--regen-prd", "--regenerate-prd", "--regen", "--fresh-prd"]) {
      const env: Record<string, string> = {};
      parseStartArgs(["./prd.md", flag], collect, () => {}, (k, v) => (env[k] = v));
      expect(env["LOKI_PRD_REGEN"]).toBe("1");
    }
    const env: Record<string, string> = {};
    parseStartArgs(["./prd.md", "--skip-memory"], collect, () => {}, (k, v) => (env[k] = v));
    expect(env["LOKI_SKIP_MEMORY"]).toBe("true");
  });

  it("--budget is an alias of --budget-limit", () => {
    const r = parseStartArgs(["./prd.md", "--budget", "3.25"], collect);
    expect((r as Exclude<typeof r, number>).budgetLimit).toBe(3.25);
  });

  it("--prd and --brief override the positional spec", () => {
    const r1 = parseStartArgs(["ignored.md", "--prd", "real.md"], collect);
    expect((r1 as Exclude<typeof r1, number>).prdPath).toBe("real.md");
    const r2 = parseStartArgs(["--brief", "build a todo app"], collect);
    expect((r2 as Exclude<typeof r2, number>).prdPath).toBe("build a todo app");
  });

  it("--help / -h prints usage and returns 0 (terminal)", () => {
    const outs: string[] = [];
    expect(parseStartArgs(["--help"], collect, (s) => outs.push(s))).toBe(0);
    expect(outs.join("")).toContain("usage: loki start");
    expect(parseStartArgs(["-h"], collect, (s) => outs.push(s))).toBe(0);
  });

  it("accept-and-ignore no-ops (--yes, --no-plan) do not reject and take no value", () => {
    const r = parseStartArgs(["--yes", "--no-plan", "./prd.md"], collect);
    expect((r as Exclude<typeof r, number>).prdPath).toBe("./prd.md");
  });

  it("-- ends options: the next token is the spec even if it looks like a flag", () => {
    const r = parseStartArgs(["--", "--weird-spec-name"], collect);
    expect((r as Exclude<typeof r, number>).prdPath).toBe("--weird-spec-name");
  });

  it("provider-specific value flags map to env", () => {
    const env: Record<string, string> = {};
    parseStartArgs(
      ["./prd.md", "--provider", "aider", "--aider-model", "gpt-x", "--cline-model", "c-y"],
      collect,
      () => {},
      (k, v) => (env[k] = v),
    );
    expect(env["LOKI_AIDER_MODEL"]).toBe("gpt-x");
    expect(env["LOKI_CLINE_MODEL"]).toBe("c-y");
  });

  it("unknown --provider -> exit 2", () => {
    errs.length = 0;
    expect(parseStartArgs(["./prd.md", "--provider", "gemini"], collect)).toBe(2);
    expect(errs.join("")).toContain("unknown --provider");
  });

  it("unknown --session-model -> exit 2", () => {
    errs.length = 0;
    expect(parseStartArgs(["./prd.md", "--session-model", "turbo"], collect)).toBe(2);
    expect(errs.join("")).toContain("unknown --session-model");
  });

  it("zero / negative numeric values fall back to undefined (not passed through)", () => {
    const r = parseStartArgs(["./prd.md", "--max-iterations", "0", "--budget-limit", "-1"], collect);
    const opts = r as Exclude<typeof r, number>;
    expect(opts.maxIterations).toBeUndefined();
    expect(opts.budgetLimit).toBeUndefined();
  });

  it("spec after flags is still found (order-independent)", () => {
    const r = parseStartArgs(["--max-iterations", "2", "owner/repo#123"], collect);
    const opts = r as Exclude<typeof r, number>;
    expect(opts.prdPath).toBe("owner/repo#123");
    expect(opts.maxIterations).toBe(2);
  });
});
