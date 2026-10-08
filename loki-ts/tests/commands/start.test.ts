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
    expect(parseStartArgs(["--yes"], collect)).toBe(2);
    expect(errs.join("")).toContain("spec source");
  });

  it("supported flags map to RunnerOpts", () => {
    // Capture env writes: --session-model exports LOKI_SESSION_MODEL, which must
    // not leak into other test files sharing this process.
    const r = parseStartArgs(
      ["./prd.md", "--budget-limit", "2.50", "--provider", "claude", "--session-model", "development", "--no-pr"],
      collect,
      () => {},
      () => {},
    );
    expect(typeof r).not.toBe("number");
    const opts = r as Exclude<typeof r, number>;
    expect(opts.prdPath).toBe("./prd.md");
    expect(opts.noPr).toBe(true);
    expect(opts.budgetLimit).toBe(2.5);
    expect(opts.provider).toBe("claude");
    expect(opts.sessionModel).toBe("development");
  });

  it("unsupported flag -> exit 2 with a clear message (no silent drop)", () => {
    errs.length = 0;
    expect(parseStartArgs(["./prd.md", "--resume", "abc"], collect)).toBe(2);
    const msg = errs.join("");
    expect(msg).toContain("--resume is not supported");
    expect(msg).toContain("only the Loki 10 engine");
  });

  // FC-38 / FC-37 class: a flag is either honored by engine10 or refused. Never accepted and dropped.
  it("every legacy-only runner flag is refused with exit 2, never accepted and dropped", () => {
    const legacy: string[][] = [
      ["--max-iterations", "5"], ["--max-retries", "2"], ["--completion-promise", "x"], ["--base-wait", "1"],
      ["--max-wait", "1"], ["--aider-model", "m"], ["--aider-flags", "f"], ["--cline-model", "m"],
      ["--allow-haiku"], ["--simple"], ["--complex"], ["--regen-prd"], ["--regenerate-prd"], ["--regen"],
      ["--fresh-prd"], ["--skip-memory"],
    ];
    for (const f of legacy) {
      errs.length = 0;
      expect(parseStartArgs(["./prd.md", ...f], collect, () => {}, () => {})).toBe(2);
      expect(errs.join("")).toContain(`flag ${f[0]} is not supported`);
    }
  });

  it("every accepted flag reaches engine10 (child argv, child env, or the attempts runner)", () => {
    const env: Record<string, string> = {};
    const r = parseStartArgs(
      ["./prd.md", "--provider", "codex", "--budget", "4", "--session-model", "opus", "--attempts", "3", "--no-pr", "--yes", "--no-plan"],
      collect, () => {}, (k, v) => (env[k] = v),
    ) as Exclude<ReturnType<typeof parseStartArgs>, number>;
    expect(r.provider).toBe("codex"); // child argv --provider
    expect(r.budgetLimit).toBe(4); // child argv --max-cost
    expect(r.noPr).toBe(true); // child argv --no-pr and the winner PR decision
    expect(r.attempts).toBe(3); // attempts runner
    expect(env["LOKI_SESSION_MODEL"]).toBe("opus"); // child env
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

  it("unknown --provider -> exit 2", () => {
    errs.length = 0;
    expect(parseStartArgs(["./prd.md", "--provider", "gemini"], collect)).toBe(2);
    expect(errs.join("")).toContain("unknown --provider");
  });

  it("direct Bun start refuses opencode so the shim can route it to the supported bash adapter", () => {
    const errors: string[] = [];
    const parsed = parseStartArgs(["spec.md", "--provider", "opencode"], (s) => errors.push(s));
    expect(parsed).toBe(2);
    expect(errors.join("")).toContain("unknown --provider 'opencode'");
  });

  it("unknown --session-model -> exit 2, and nothing is exported", () => {
    errs.length = 0;
    const env: Record<string, string> = {};
    expect(parseStartArgs(["./prd.md", "--session-model", "turbo"], collect, () => {}, (k, v) => (env[k] = v))).toBe(2);
    expect(errs.join("")).toContain("unknown --session-model");
    expect(env["LOKI_SESSION_MODEL"]).toBeUndefined();
  });

  // Moat P4: the top-only setting is `--session-model opus`. It was rejected
  // here although run.sh accepts every Claude alias as a session pin.
  it("accepts the run.sh session-pin aliases and exports LOKI_SESSION_MODEL like run.sh", () => {
    for (const [given, pinned] of [
      ["opus", "opus"], ["sonnet", "sonnet"], ["haiku", "haiku"], ["fable", "fable"],
      ["high", "planning"], ["small", "fast"], ["development", "development"],
    ] as const) {
      const env: Record<string, string> = {};
      const r = parseStartArgs(["./prd.md", "--session-model", given], collect, () => {}, (k, v) => (env[k] = v));
      expect(typeof r).not.toBe("number");
      expect((r as Exclude<typeof r, number>).sessionModel).toBe(pinned);
      expect(env["LOKI_SESSION_MODEL"]).toBe(pinned);
    }
  });

  it("zero / negative numeric values fall back to undefined (not passed through)", () => {
    const r = parseStartArgs(["./prd.md", "--budget-limit", "-1"], collect);
    const opts = r as Exclude<typeof r, number>;
    expect(opts.budgetLimit).toBeUndefined();
  });

  it("spec after flags is still found (order-independent)", () => {
    const r = parseStartArgs(["--budget", "2", "owner/repo#123"], collect);
    const opts = r as Exclude<typeof r, number>;
    expect(opts.prdPath).toBe("owner/repo#123");
    expect(opts.budgetLimit).toBe(2);
  });
});
