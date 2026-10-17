// v8 Phase 4 Story 5: pure test for the Bun `loki start` arg parser. Proves the
// supported-flag subset maps to RunnerOpts and unsupported flags are REJECTED
// (never silently dropped -- that would be a hidden capability loss under
// LOKI_SDK_LOOP=1). The runAutonomous delegation itself is covered by the
// existing loki_start_e2e.test.ts.
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capSourceLine, dryRunStart, deployFlagError, isBashOnlyStart, missingPrdMessage, parseStartArgs, scopedStartEnv, startEngine, writebackEnv } from "../../src/commands/start.ts";
import { VALID_PROVIDERS } from "../../src/runner/router/cost_preview.ts";

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
  it("value flag swallows flag: a missing, empty or dash-leading value is exit 2 naming the flag", () => {
    for (const f of ["--brief", "--prd", "--completion-promise", "--aider-model", "--aider-flags", "--cline-model"]) {
      for (const argv of [["./prd.md", f, "--yes"], ["./prd.md", f], ["./prd.md", f, ""], ["./prd.md", `${f}=`]]) {
        errs.length = 0;
        expect(parseStartArgs(argv, collect, () => {}, () => {})).toBe(2);
        expect(errs.join("")).toContain(`start: ${f} needs a value`);
      }
    }
    const r = parseStartArgs(["--brief=-x"], collect, () => {}, () => {});
    expect(typeof r).toBe("object");
    expect((r as { prdPath: string }).prdPath).toBe("-x");
  });

  it("value flags need a value: --provider, --session-model, --cost, --spec", () => {
    for (const f of ["--provider", "--session-model", "--cost", "--spec"]) {
      for (const argv of [["x", f], ["x", f, "--simple"], ["x", f, ""], ["x", `${f}=`]]) {
        errs.length = 0;
        expect(parseStartArgs(argv, collect, () => {}, () => {})).toBe(2);
        expect(errs.join("")).toContain(`start: ${f} needs a value`);
      }
    }
    const r = spawnSync(process.execPath, [join(import.meta.dir, "../../src/cli.ts"), "start", "x", "--provider"], { cwd: tmpdir(), encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("start: --provider needs a value");
  });

  it("value flag swallows flag: real CLI entry exits 2 without starting a run", () => {
    const r = spawnSync(process.execPath, [join(import.meta.dir, "../../src/cli.ts"), "start", "./prd.md", "--brief", "--yes"], { cwd: tmpdir(), encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("start: --brief needs a value");
  });

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
    expect(msg).not.toContain("LOKI_SDK_LOOP");
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

  it("--prd and --brief supply the spec when given alone", () => {
    const r1 = parseStartArgs(["--prd", "real.md"], collect);
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

  it("unknown provider lists valid", () => {
    errs.length = 0;
    expect(parseStartArgs(["./prd.md", "--provider", "gemini"], collect)).toBe(2);
    const msg = errs.join("");
    expect(msg).toContain("unknown --provider 'gemini' (use one of: ");
    for (const p of VALID_PROVIDERS) expect(msg).toContain(p);
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
describe("equals form (TEN-COST-35)", () => {
  it("equals form of value flags is read, not silently ignored", () => {
    const r = parseStartArgs(
      ["--prd=./prd.md", "--budget-limit=5", "--provider=claude", "--session-model=development", "--max-iterations=7"],
      collect,
      () => {},
      () => {},
    );
    expect(typeof r).toBe("object");
    const o = r as unknown as Record<string, unknown>;
    expect(o["budgetLimitUsd"] ?? o["budget"] ?? JSON.stringify(o)).toBeDefined();
    expect(JSON.stringify(o)).toContain("5");
    expect(o["provider"]).toBe("claude");
    expect(o["maxIterations"]).toBe(7);
  });
});

describe("invalid numeric flags (TEN-COST-36)", () => {
  const cases: string[][] = [
    ["p.md", "--budget-limit", "abc"],
    ["p.md", "--max-iterations", "-1"],
    ["p.md", "--budget-limit", "0x"],
    ["p.md", "--budget-limit", "0"],
    ["p.md", "--max-retries=abc"],
    ["p.md", "--budget-limit"],
  ];
  for (const c of cases) {
    it(`invalid numeric: ${c.slice(1).join(" ")} exits 2 naming the flag`, () => {
      const errs: string[] = [];
      const r = parseStartArgs(c, (s) => errs.push(s), () => {}, () => {});
      expect(r).toBe(2);
      expect(errs.join("")).toMatch(/^start: --[a-z-]+ must be a positive number/);
    });
  }
  it("valid numeric values unchanged", () => {
    const r = parseStartArgs(["p.md", "--budget-limit", "2.5", "--max-iterations=3"], collect, () => {}, () => {}) as { budgetLimit?: number; maxIterations?: number };
    expect(r.budgetLimit).toBe(2.5);
    expect(r.maxIterations).toBe(3);
  });
});

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

  it("unknown flag suggestion: plain start suggests the closest flag and hides runner internals", () => {
    errs.length = 0;
    expect(parseStartArgs(["./prd.md", "--bugdet", "4"], collect)).toBe(2);
    const out = errs.join("");
    expect(out).toContain("flag --bugdet is not supported by loki start. Did you mean --budget?");
    expect(out).not.toContain("LOKI_SDK_LOOP");
    errs.length = 0;
    expect(parseStartArgs(["x", "--zzzzzzzzzzzz"], collect)).toBe(2);
    expect(errs.join("")).not.toContain("Did you mean");
    expect(errs.join("")).not.toContain("LOKI_SDK_LOOP");
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

describe("missing prd path (TEN-STABILITY-30)", () => {
  const none = () => false;
  const yes = () => true;
  it("missing prd path: path-shaped positional that does not exist -> message", () => {
    for (const p of ["./prd.md", "prd.md", "docs/spec", "x.yaml", "x.JSON", "a.txt", "a.yml"]) {
      expect(missingPrdMessage([p], p, none)).toBe(`PRD file not found: ${p}\n`);
    }
  });
  it("spaced prd path: slash-containing token ending in a doc extension is a path even with spaces", () => {
    for (const p of ["My Docs/prd.md", "docs/my spec.pdf", "a b/c d.yaml"]) {
      expect(missingPrdMessage([p], p, none)).toBe(`PRD file not found: ${p}\n`);
      expect(missingPrdMessage([p], p, yes)).toBeNull();
    }
    for (const b of ["add docs/readme.md support", "build a thing", "write notes.md for me"]) expect(missingPrdMessage([b], b, none)).toBeNull();
  });
  it("spaced prd path: real entry (cli.ts start) exits 2 before any run", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-ux50-"));
    try {
      const r = spawnSync("bun", [join(import.meta.dir, "../../src/cli.ts"), "start", "My Docs/prd.md"], { cwd: dir, encoding: "utf8", timeout: 60000 });
      expect(r.status).toBe(2);
      expect(r.stderr + r.stdout).toContain("PRD file not found: My Docs/prd.md");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("missing prd path: --prd FILE and --prd=FILE always require the file", () => {
    expect(missingPrdMessage(["--prd", "plain"], "plain", none)).toBe("PRD file not found: plain\n");
    expect(missingPrdMessage(["--prd=plain"], "plain", none)).toBe("PRD file not found: plain\n");
  });
  it("existing files, plain briefs, issue refs, URLs, --brief and empty spec are unchanged", () => {
    expect(missingPrdMessage(["./prd.md"], "./prd.md", yes)).toBeNull();
    for (const b of ["build a todo app", "build a CRUD/REST api", "owner/repo#123", "jira:ABC-12", "https://x.io/a.md", "todo", ""]) {
      expect(missingPrdMessage([b], b, none)).toBeNull();
    }
    expect(missingPrdMessage(["--brief", "./prd.md"], "./prd.md", none)).toBeNull();
  });
  it("missing prd path: real entry (cli.ts start) exits 2 before any run", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-s30-"));
    try {
      for (const a of [["start", "./nope/prd.md"], ["start", "--prd", "nope"]]) {
        const r = spawnSync(process.execPath, [join(import.meta.dir, "../../src/cli.ts"), ...a], { cwd: dir, encoding: "utf8", timeout: 20_000 });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain("PRD file not found:");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cap source line (TEN-COST-41)", () => {
  it("cap source line: flag names --budget-limit", async () => {
    expect(await capSourceLine(7, tmpdir(), {})).toBe("cap $7.00 (--budget-limit)");
  });
  it("cap source line: env and default are named by the runner note, not repeated", async () => {
    const { runnerBudget } = await import("../../src/e10ext/budget_cap.ts");
    expect(await capSourceLine(undefined, tmpdir(), { LOKI_BUDGET_LIMIT: "5" })).toBeNull();
    expect(runnerBudget(undefined, tmpdir(), { LOKI_BUDGET_LIMIT: "5" }).note).toBe("cap $5.00 (env)");
    expect(await capSourceLine(undefined, tmpdir(), { ANTHROPIC_API_KEY: "k" })).toBeNull();
    expect(runnerBudget(undefined, tmpdir(), { ANTHROPIC_API_KEY: "k" }).note).toBe("cap $100.00 (default)");
  });
  it("cap source line: subscription run says no dollar cap", async () => {
    expect(await capSourceLine(undefined, tmpdir(), {})).toBe("no dollar cap (subscription)");
  });
  it("cap source line: real entry (cli.ts start --budget-limit) prints the line before the run", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-c41-"));
    try {
      writeFileSync(join(dir, "prd.md"), "# x\n");
      const env = { ...process.env, PATH: "/usr/bin:/bin", LOKI_BUDGET_LIMIT: "" };
      const r = spawnSync(process.execPath, [join(import.meta.dir, "../../src/cli.ts"), "start", "prd.md", "--budget-limit", "7"], { cwd: dir, encoding: "utf8", timeout: 8_000, env });
      expect(r.stdout).toContain("[runner] cap $7.00 (--budget-limit)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deploy flags fail before build (TEN-DEPLOY-21)", () => {
  const bad: Array<[string[], string]> = [
    [["--deploy", "--destination", "prod"], "--destination"],
    [["--deploy", "--destination=prod"], "--destination"],
    [["--deploy", "--auto-rollback"], "--health-url"],
    [["--deploy", "--health-match", "ok"], "--health-url"],
    [["--deploy", "--canary", "--destination", "staging"], "--canary"],
    [["--deploy", "--canary", "--destination=preview"], "--canary"],
  ];
  it("deploy flags fail before build: each invalid combination is named", () => {
    for (const [a, flag] of bad) expect(deployFlagError(["p.md", ...a])).toContain(flag);
  });
  it("deploy flags fail before build: valid combinations unchanged", () => {
    const h = ["--health-url", "https://x.io/h"];
    expect(deployFlagError(["--deploy", "--destination", "staging"])).toBeNull();
    expect(deployFlagError(["--deploy", "--canary"])).toBeNull();
    expect(deployFlagError(["--deploy", "--canary", "--destination", "production"])).toBeNull();
    expect(deployFlagError(["--deploy", ...h, "--auto-rollback", "--health-match", "ok"])).toBeNull();
  });
  it("deploy flags fail before build: real entry (cli.ts start) exits 2 before any run", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-d21-"));
    try {
      for (const [a, flag] of bad) {
        const r = spawnSync(process.execPath, [join(import.meta.dir, "../../src/cli.ts"), "start", "build a thing", ...a], { cwd: dir, encoding: "utf8", timeout: 20_000 });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain(flag);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deploy flag validation (TEN-DEPLOY-19)", () => {
  it("deploy flag validation: bad health-url and domain are named", () => {
    for (const u of ["notaurl", "ftp://x.io/h", "http://", "x.io/health", "javascript:alert(1)"]) {
      expect(deployFlagError(["p.md", "--deploy", "--health-url", u])).toContain("--health-url");
      expect(deployFlagError([`--health-url=${u}`, "--deploy"])).toContain("--health-url");
    }
    for (const d of ["https://x.io", "x.io/path", "x.io:8080", "bad host", "x-.io", "x..io"]) {
      expect(deployFlagError(["p.md", "--deploy", "--domain", d])).toContain("--domain");
      expect(deployFlagError([`--domain=${d}`, "--deploy"])).toContain("--domain");
    }
  });
  it("deploy flag validation: valid values and absent flags are unchanged", () => {
    expect(deployFlagError(["p.md", "--deploy"])).toBeNull();
    expect(deployFlagError(["--deploy", "--health-url", "https://app.example.com:8443/health?x=1", "--domain", "app.example.com"])).toBeNull();
    expect(deployFlagError(["--deploy", "--health-url=http://localhost:3000", "--domain=localhost"])).toBeNull();
  });
  it("deploy flag validation: real entry (cli.ts start) exits 2 before any run", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-d19-"));
    try {
      for (const [a, flag] of [[["--health-url", "notaurl"], "--health-url"], [["--domain", "https://x.io"], "--domain"]] as const) {
        const r = spawnSync(process.execPath, [join(import.meta.dir, "../../src/cli.ts"), "start", "build a thing", "--deploy", ...a], { cwd: dir, encoding: "utf8", timeout: 20_000 });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain(flag);
        expect(r.stderr.trim().split("\n").length).toBe(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("env-file missing (TEN-DEPLOY-20)", () => {
  it("env-file missing: absent path and directory are named, existing file is accepted", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-d20-"));
    try {
      const f = join(dir, "ok.env");
      writeFileSync(f, "A=1\n");
      expect(deployFlagError(["p.md", "--deploy", "--env-file", join(dir, "missing.env")])).toContain("--env-file");
      expect(deployFlagError([`--env-file=${join(dir, "missing.env")}`, "--deploy"])).toContain("--env-file");
      expect(deployFlagError(["--deploy", "--env-file", dir])).toContain("--env-file");
      expect(deployFlagError(["--deploy", "--env-file", f])).toBeNull();
      expect(deployFlagError(["--deploy"])).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("env-file missing: real entry (cli.ts start) exits 2 before any run", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-d20-"));
    try {
      const r = spawnSync(process.execPath, [join(import.meta.dir, "../../src/cli.ts"), "start", "build a thing", "--deploy", "--env-file", "./missing.env"], { cwd: dir, encoding: "utf8", timeout: 20_000 });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--env-file");
      expect(r.stderr.trim().split("\n").length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conflicting spec sources (TEN-UX-32)", () => {
  it("conflicting spec sources: different positional, --prd, --brief exit 2 naming all", () => {
    const e: string[] = [];
    const r = parseStartArgs(["./a.md", "--prd", "./b.md", "--brief", "x"], (s) => e.push(s), () => {}, () => {});
    expect(r).toBe(2);
    const m = e.join("");
    for (const t of ["./a.md", "./b.md", '"x"', "--prd", "--brief"]) expect(m).toContain(t);
  });
  it("conflicting spec sources: single source and --prd equal to positional are unchanged", () => {
    const noop = () => {};
    expect(typeof parseStartArgs(["./a.md"], noop, noop, noop)).toBe("object");
    expect(typeof parseStartArgs(["--brief", "x"], noop, noop, noop)).toBe("object");
    expect(typeof parseStartArgs(["./a.md", "--prd", "./a.md"], noop, noop, noop)).toBe("object");
  });
  it("conflicting spec sources: real entry (cli.ts start) exits 2", () => {
    const r = spawnSync(process.execPath, [join(import.meta.dir, "../../src/cli.ts"), "start", "build a todo app", "--brief", "other thing"], { encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("conflicting spec sources");
  });
});

describe("conflicting budget flags (TEN-COST-43)", () => {
  it("conflicting budget flags: differing values exit 2 naming both flags", () => {
    const e: string[] = [];
    const r = parseStartArgs(["./a.md", "--budget-limit", "5", "--budget", "50"], (s) => e.push(s), () => {}, () => {});
    expect(r).toBe(2);
    const m = e.join("");
    expect(m).toContain("--budget-limit");
    expect(m).toContain("--budget 50");
  });
  it("conflicting budget flags: equal values and a single flag unchanged", () => {
    const noop = () => {};
    const a = parseStartArgs(["./a.md", "--budget-limit", "5", "--budget", "5"], noop, noop, noop);
    expect(typeof a === "object" && a.budgetLimit).toBe(5);
    const b = parseStartArgs(["./a.md", "--budget", "7"], noop, noop, noop);
    expect(typeof b === "object" && b.budgetLimit).toBe(7);
  });
  it("conflicting budget flags: real entry (cli.ts start) exits 2", () => {
    const r = spawnSync(process.execPath, [join(import.meta.dir, "../../src/cli.ts"), "start", "build a todo app", "--budget-limit", "5", "--budget", "50"], { encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("conflicting budget flags");
  });
});

describe("deploy flag missing value (TEN-DEPLOY-26)", () => {
  const bad: string[][] = [["--health-url"], ["--destination"], ["--env-file"], ["--domain"], ["--domain", "--simple"], ["--health-url", "--auto-rollback"]];
  it("deploy flag missing value: each is named", () => {
    for (const a of bad) expect(deployFlagError(["x", "--deploy", ...a])).toContain(`${a[0]} requires a value`);
  });
  it("deploy flag missing value: real entry (cli.ts start) exits 2 before any run", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-d26-"));
    try {
      for (const a of bad) {
        const r = spawnSync(process.execPath, [join(import.meta.dir, "../../src/cli.ts"), "start", "build a thing", "--deploy", ...a], { cwd: dir, encoding: "utf8", timeout: 20_000 });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain(`${a[0]} requires a value`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("start --dry-run (TEN-UX-45)", () => {
  const repo = (): string => {
    const d = mkdtempSync(join(tmpdir(), "start-dry-"));
    for (const a of [["init", "-q"], ["config", "user.name", "t"], ["config", "user.email", "t@example.com"], ["commit", "-q", "--allow-empty", "-m", "init"]]) spawnSync("git", a, { cwd: d });
    return d;
  };
  const cli = (args: string[], cwd: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [join(import.meta.dir, "../../src/cli.ts"), "start", ...args], { cwd, encoding: "utf8", timeout: 25_000, env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", LOKI_BUDGET_LIMIT: "", ...env } });

  it("parses --dry-run as a flag, never an unknown-flag error", () => {
    const r = parseStartArgs(["x", "--dry-run", "--provider", "codex"], collect, () => {}, () => {});
    expect(typeof r).toBe("object");
    expect((r as { dryRun?: boolean }).dryRun).toBe(true);
  });

  it("dry-run still validates flags: bad provider exits 2", () => {
    errs.length = 0;
    expect(parseStartArgs(["x", "--dry-run", "--provider", "nope"], collect, () => {}, () => {})).toBe(2);
    expect(errs.join("")).toContain("unknown --provider");
  });

  it("real CLI: prints provider, model and cap, exits 0, starts no run", () => {
    const d = repo();
    try {
      const fake = join(d, "fakeclaude");
      writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const r = cli(["build a todo app", "--dry-run", "--budget-limit", "7", "--session-model", "high"], d, { CLAUDE_CODE_OAUTH_TOKEN: "x", LOKI_CLAUDE_CLI: fake });
      expect(r.stderr).not.toContain("not supported");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("dry-run: provider claude, model planning, cap $7.00 (--budget-limit)");
      expect(r.stdout).toContain("nothing was run");
      expect(spawnSync("ls", [join(d, ".loki")], { encoding: "utf8" }).status).not.toBe(0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("real CLI: a failing preflight (CLI missing) exits 2 and names the fix", () => {
    const d = repo();
    try {
      const r = cli(["x", "--dry-run"], d, { LOKI_CLAUDE_CLI: "/nonexistent/claude-zz", CLAUDE_CODE_OAUTH_TOKEN: "x" });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("dry-run preflight failed");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  const viaBin = (args: string[], cwd: string, env: Record<string, string> = {}) =>
    spawnSync(join(import.meta.dir, "../../../bin/loki"), ["start", ...args], { cwd, encoding: "utf8", timeout: 40_000, env: { ...process.env, BUN_FROM_SOURCE: "1", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", LOKI_BUDGET_LIMIT: "", ...env } });

  it("bin/loki: start --dry-run (PRD path and --attempts) reaches the Bun preview and starts no run", () => {
    const d = repo();
    try {
      const fake = join(d, "fakeclaude");
      writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(d, "p.md"), "build a thing\n");
      for (const a of [["--dry-run", "p.md"], ["--attempts", "2", "--dry-run", "p.md"]]) {
        const r = viaBin(a, d, { CLAUDE_CODE_OAUTH_TOKEN: "x", LOKI_CLAUDE_CLI: fake });
        expect(r.stderr).not.toContain("legacy engine");
        expect(r.stderr).not.toContain("legacy flag");
        expect(r.status).toBe(0);
        expect(r.stdout).toContain("dry-run: provider claude");
        expect(spawnSync("ls", [join(d, ".loki")], { encoding: "utf8" }).status).not.toBe(0);
      }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("dryRunStart reports a subscription run with no dollar cap", async () => {
    const d = repo();
    const out: string[] = [];
    try {
      const fake = join(d, "fc"); writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const o = parseStartArgs(["x", "--dry-run"], collect, () => {}, () => {}) as Parameters<typeof dryRunStart>[0];
      const code = await dryRunStart(o, d, { PATH: process.env["PATH"], LOKI_CLAUDE_CLI: fake, CLAUDE_CODE_OAUTH_TOKEN: "x" }, (s) => out.push(s), () => {});
      expect(code).toBe(0);
      expect(out.join("")).toContain("no dollar cap (subscription)");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
