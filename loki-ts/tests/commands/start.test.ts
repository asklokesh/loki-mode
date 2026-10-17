// v8 Phase 4 Story 5: pure test for the Bun `loki start` arg parser. Proves the
// supported-flag subset maps to RunnerOpts and unsupported flags are REJECTED
// (never silently dropped -- that would be a hidden capability loss under
// LOKI_SDK_LOOP=1). The runAutonomous delegation itself is covered by the
// existing loki_start_e2e.test.ts.
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBashOnlyStart, parseStartArgs, scopedStartEnv, startEngine, writebackEnv } from "../../src/commands/start.ts";

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
    // Capture env writes: --session-model exports LOKI_SESSION_MODEL, which must
    // not leak into other test files sharing this process.
    const r = parseStartArgs(
      ["./prd.md", "--max-iterations", "5", "--budget-limit", "2.50", "--provider", "claude", "--session-model", "development"],
      collect,
      () => {},
      () => {},
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

  it("--cost lean reaches the child env and prints one line naming both levers", () => {
    const env: Record<string, string> = {};
    const saved = { r: process.env["LOKI_ROUTER"], t: process.env["LOKI_E10_TRIM"], c: process.env["LOKI_COST_PROFILE"], d: process.env["LOKI_DIR"], h: process.env["LOKI_IMPLEMENT_HAIKU_FIRST"] };
    delete process.env["LOKI_ROUTER"]; delete process.env["LOKI_E10_TRIM"]; delete process.env["LOKI_COST_PROFILE"]; delete process.env["LOKI_IMPLEMENT_HAIKU_FIRST"];
    const dir = mkdtempSync(join(tmpdir(), "start-cost-"));
    process.env["LOKI_DIR"] = dir;
    try {
      const lines: string[] = [];
      const r = parseStartArgs(["./prd.md", "--cost", "lean"], collect, (s) => lines.push(s), (k, v) => { env[k] = v; });
      expect(typeof r).toBe("object");
      expect(env["LOKI_ROUTER"]).toBeUndefined();
      expect(env["LOKI_IMPLEMENT_HAIKU_FIRST"]).toBe("1");
      expect(env["LOKI_E10_TRIM"]).toBe("1");
      expect(lines.join("")).toMatch(/LOKI_IMPLEMENT_HAIKU_FIRST=1.*LOKI_E10_TRIM=1/);
      errs.length = 0;
      expect(parseStartArgs(["./prd.md", "--cost", "cheap"], collect)).toBe(2);
      expect(errs.join("")).toContain("unknown cost profile");
    } finally {
      for (const [k, v] of [["LOKI_ROUTER", saved.r], ["LOKI_E10_TRIM", saved.t], ["LOKI_COST_PROFILE", saved.c], ["LOKI_DIR", saved.d], ["LOKI_IMPLEMENT_HAIKU_FIRST", saved.h]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loki.yaml cost.profile is the team default; flag and env override; invalid warns", () => {
    const keys = ["LOKI_COST_PROFILE", "LOKI_DIR", "LOKI_IMPLEMENT_HAIKU_FIRST", "LOKI_E10_TRIM", "LOKI_E10_SMALL_NO_RUNNER", "LOKI_E10_SMALL_MAX_CHARS"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "start-costyaml-"));
    const run = (extra: string[], yaml: string | null, envProfile?: string) => {
      for (const k of keys) delete process.env[k];
      process.env["LOKI_DIR"] = join(dir, ".loki");
      if (envProfile !== undefined) process.env["LOKI_COST_PROFILE"] = envProfile;
      rmSync(join(dir, "loki.yaml"), { force: true });
      if (yaml !== null) writeFileSync(join(dir, "loki.yaml"), yaml);
      const env: Record<string, string> = {};
      errs.length = 0;
      const r = parseStartArgs(["./prd.md", ...extra], collect, () => {}, (k, v) => { env[k] = v; });
      return { r, env };
    };
    try {
      process.chdir(dir);
      expect(run([], null).env["LOKI_IMPLEMENT_HAIKU_FIRST"]).toBeUndefined();
      expect(run([], "cost:\n  profile: lean\n").env["LOKI_IMPLEMENT_HAIKU_FIRST"]).toBe("1");
      expect(run(["--cost", "off"], "cost:\n  profile: lean\n").env["LOKI_IMPLEMENT_HAIKU_FIRST"]).toBeUndefined();
      expect(run([], "cost:\n  profile: lean\n", "off").env["LOKI_IMPLEMENT_HAIKU_FIRST"]).toBeUndefined();
      expect(run([], "cost:\n  other:\n    profile: lean\n").env["LOKI_IMPLEMENT_HAIKU_FIRST"]).toBeUndefined();
      const bad = run([], "cost:\n  profile: cheap\n");
      expect(typeof bad.r).toBe("object");
      expect(bad.env["LOKI_IMPLEMENT_HAIKU_FIRST"]).toBeUndefined();
      expect(errs.join("")).toContain("ignoring loki.yaml cost.profile 'cheap'");
    } finally {
      process.chdir(cwd);
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
      rmSync(dir, { recursive: true, force: true });
    }
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
    // TEN-COST-25: the --cost lean help line names the real lean levers, not the dropped router.
    const costLine = outs.join("").split("\n").find((l) => l.includes("--cost lean   opt-in")) ?? "";
    expect(costLine).toContain("LOKI_IMPLEMENT_HAIKU_FIRST=1");
    expect(costLine).toContain("LOKI_E10_SMALL_MAX_CHARS=1200");
    expect(costLine).not.toContain("LOKI_ROUTER");
    expect(parseStartArgs(["-h"], collect, (s) => outs.push(s))).toBe(0);
  });

  it("--help ends with an Examples section: brief, PRD file, issue ref (TEN-UX-19)", () => {
    const outs: string[] = [];
    expect(parseStartArgs(["--help"], collect, (s) => outs.push(s))).toBe(0);
    const text = outs.join("");
    const idx = text.indexOf("\nExamples:\n");
    expect(idx).toBeGreaterThan(0);
    const lines = text.slice(idx).split("\n").filter((l) => l.trim().startsWith("loki start"));
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('loki start "build a todo app"');
    expect(lines[1]).toContain("loki start ./prd.md");
    expect(lines[2]).toContain("loki start owner/repo#123");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd().split("\n").pop()).toContain("owner/repo#123");
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

  it("direct Bun start accepts opencode (a supported provider since v11.4)", () => {
    const errors: string[] = [];
    const parsed = parseStartArgs(["spec.md", "--provider", "opencode"], (s) => errors.push(s));
    expect(errors.join("")).not.toContain("unknown --provider");
    expect(parsed).not.toBe(2);
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

// FC-38 scoped (CTO ruling A): only `start --attempts` is engine10-only. Every other start keeps the
// exact 11.3.0 flag surface and runner route; the moat P9 harness runs `start prd.md --max-iterations 2`.
describe("FC-38 scope: plain start is 11.3.0, --attempts is engine10-only", () => {
  const legacy: string[][] = [
    ["--max-iterations", "5"], ["--max-retries", "2"], ["--completion-promise", "x"], ["--base-wait", "1"],
    ["--max-wait", "1"], ["--aider-model", "m"], ["--aider-flags", "f"], ["--cline-model", "m"],
    ["--allow-haiku"], ["--simple"], ["--complex"], ["--regen-prd"], ["--regenerate-prd"], ["--regen"],
    ["--fresh-prd"], ["--skip-memory"],
  ];

  it("plain start prd.md --max-iterations 2 parses as in 11.3.0 and routes to the runner", () => {
    errs.length = 0;
    const r = parseStartArgs(["prd.md", "--max-iterations", "2"], collect, () => {}, () => {});
    expect(typeof r).not.toBe("number");
    const opts = r as Exclude<typeof r, number>;
    expect(opts.prdPath).toBe("prd.md");
    expect(opts.maxIterations).toBe(2);
    expect(opts.attempts).toBeUndefined();
    expect(startEngine(opts)).toBe("runner");
    expect(errs.join("")).toBe("");
  });

  it("every legacy runner flag is accepted on plain start (11.3.0) and routes to the runner", () => {
    for (const f of legacy) {
      errs.length = 0;
      const r = parseStartArgs(["./prd.md", ...f], collect, () => {}, () => {});
      expect(typeof r).not.toBe("number");
      expect(startEngine(r as Exclude<typeof r, number>)).toBe("runner");
      expect(errs.join("")).toBe("");
    }
  });

  it("plain start keeps the 11.3.0 refusal text for unsupported flags", () => {
    errs.length = 0;
    expect(parseStartArgs(["./prd.md", "--no-pr"], collect)).toBe(2);
    expect(errs.join("")).toContain("not supported by the Bun (LOKI_SDK_LOOP) runner");
  });

  it("with --attempts every legacy-only runner flag is refused with exit 2, never accepted and dropped", () => {
    for (const f of legacy) {
      errs.length = 0;
      expect(parseStartArgs(["./prd.md", "--attempts", "2", "--no-pr", ...f], collect, () => {}, () => {})).toBe(2);
      expect(errs.join("")).toContain(`flag ${f[0]} is not supported by loki start --attempts`);
    }
  });

  it("with --attempts every accepted flag reaches engine10 (child argv, child env, or the attempts runner)", () => {
    const env: Record<string, string> = {};
    const r = parseStartArgs(
      ["./prd.md", "--provider", "codex", "--budget", "4", "--session-model", "opus", "--attempts", "3", "--no-pr", "--yes", "--no-plan"],
      collect, () => {}, (k, v) => (env[k] = v),
    ) as Exclude<ReturnType<typeof parseStartArgs>, number>;
    expect(r.provider).toBe("codex");
    expect(r.budgetLimit).toBe(4);
    expect(r.noPr).toBe(true);
    expect(r.attempts).toBe(3);
    expect(env["LOKI_SESSION_MODEL"]).toBe("opus");
    expect(startEngine(r)).toBe("attempts");
  });

  it("--attempts=1 still takes the attempts (engine10) path", () => {
    const r = parseStartArgs(["./prd.md", "--attempts=1"], collect, () => {}, () => {});
    expect(startEngine(r as Exclude<typeof r, number>)).toBe("attempts");
  });

  it("--attempts out of range -> exit 2", () => {
    errs.length = 0;
    expect(parseStartArgs(["./prd.md", "--attempts", "9"], collect)).toBe(2);
    expect(errs.join("")).toContain("--attempts must be an integer from 1 to 5");
  });
});

describe("PATH: --workspace and --deploy divert to the bash route", () => {
  it("diverts alone, never with --attempts or --spec", () => {
    expect(isBashOnlyStart(["--workspace", "ws", "do it"])).toBe(true);
    expect(isBashOnlyStart(["--workspace=ws", "do it"])).toBe(true);
    expect(isBashOnlyStart(["prd.md", "--deploy", "--health-url", "http://x"])).toBe(true);
    expect(isBashOnlyStart(["prd.md"])).toBe(false);
    expect(isBashOnlyStart(["prd.md", "--deploy", "--attempts", "2"])).toBe(false);
    expect(isBashOnlyStart(["--workspace", "ws", "--spec", "f.md"])).toBe(false);
  });
  it("attempts mode still refuses --workspace loudly", () => {
    const errs: string[] = [];
    expect(parseStartArgs(["x", "--attempts", "2", "--workspace", "ws"], (e) => errs.push(e))).toBe(2);
    expect(errs.join("")).toContain("--workspace");
  });
});

describe("PATH: bash divert env is scoped", () => {
  it("forwards PATH, LOKI_* and provider keys but not unrelated secrets", () => {
    const out = scopedStartEnv({ PATH: "/bin", HOME: "/h", LOKI_X: "1", ANTHROPIC_API_KEY: "k", FOO_SECRET: "s", DATABASE_PASSWORD: "p" });
    expect(out.PATH).toBe("/bin");
    expect(out.LOKI_X).toBe("1");
    expect(out.ANTHROPIC_API_KEY).toBe("k");
    expect(out.FOO_SECRET).toBeUndefined();
    expect(out.DATABASE_PASSWORD).toBeUndefined();
  });
});

describe("writebackEnv (tracker ref exports LOKI_WRITEBACK_ISSUE)", () => {
  it("sets the key for jira: and linear: refs, leaves plain text alone", () => {
    expect(writebackEnv("jira:PROJ-123", {}).LOKI_WRITEBACK_ISSUE).toBe("PROJ-123");
    expect(writebackEnv("linear:ENG-42", {}).LOKI_WRITEBACK_ISSUE).toBe("ENG-42");
    expect(writebackEnv("linear:ENG-42", {}).LOKI_WRITEBACK_KIND).toBe("linear");
    expect(writebackEnv("jira:PROJ-123", {}).LOKI_WRITEBACK_KIND).toBe("jira");
    expect(writebackEnv("add a login page", {}).LOKI_WRITEBACK_ISSUE).toBeUndefined();
  });
});
