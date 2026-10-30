// D61-16: LOKI_SPEED routing of `loki "<task>"` / `loki <file>` through the decomposer.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../../src/engine10/cli.ts";
import { receiptSha256 } from "../../src/engine10/stages/seal.ts";
import { verifyReceipt } from "../../src/engine10/verify_cmd.ts";
import { maybeRunGroup, MAX_SEQ_TASK_BYTES, MAX_SPEC_BYTES, type GroupCtx, type GroupRunner } from "../../src/features/speed/route.ts";

const SPEC = "- update src/a.ts to add alpha\n- update src/b.ts to add beta\n- update src/c.ts to add gamma\n";
const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
const sel = (t: string): string[] => files.filter((f) => t.includes(f));
const run = async (task: string, env: Record<string, string | undefined>, group?: GroupRunner, repo = "/x", cwd?: string) => {
  let err = "";
  const res = await maybeRunGroup(task, repo, env as NodeJS.ProcessEnv, { group, listFiles: () => files, select: sel, stderr: (s) => { err += s; }, cwd });
  return { r: res.code, task: res.task, err };
};
const withDir = async (fn: (d: string) => Promise<void>): Promise<void> => {
  const d = mkdtempSync(join(tmpdir(), "loki-route-group-"));
  try { await fn(d); } finally { rmSync(d, { recursive: true, force: true }); }
};
const ON = { LOKI_SPEED: "1" };
const SEQ = { LOKI_SPEED: "1", LOKI_PROVIDER: "aider" }; // a sequential provider always falls back, so these tests need no group runner

describe("flag off is byte-identical", () => {
  test("route result and no group call for LOKI_SPEED=0", async () => {
    const before = route(["fix x"]);
    let calls = 0;
    const g: GroupRunner = async () => { calls++; return 0; };
    for (const env of [{ LOKI_SPEED: "0" }]) {
      const { r, err } = await run(SPEC, env, g);
      expect(r).toBeNull();
      expect(err).toBe("");
    }
    expect(calls).toBe(0);
    expect(route(["fix x"])).toEqual(before);
    expect(before).toEqual({ module: "supervisor.ts", fn: "main", args: ["fix x"] });
  });
  test("cli.ts dispatch is untouched by D61-16", () => {
    expect(readFileSync(join(import.meta.dir, "../../src/engine10/cli.ts"), "utf8")).not.toContain("speed/route");
  });
  test("supervisor gates the import on LOKI_SPEED=1 and skips issue refs", () => {
    const s = readFileSync(join(import.meta.dir, "../../src/engine10/supervisor.ts"), "utf8");
    expect(s).toMatch(/LOKI_SPEED !== "0" && !isIssue[^\n]*speed\/route\.ts/);
  });
});

describe("flag on", () => {
  test("a small one-line task never decomposes", async () => {
    let calls = 0;
    const { r } = await run("fix the off-by-one in src/a.ts", { LOKI_SPEED: "1" }, async () => { calls++; return 0; });
    expect(r).toBeNull();
    expect(calls).toBe(0);
  });
  test("a decomposable spec runs the group and returns its rc", async () => {
    let units = 0;
    const { r, err } = await run(SPEC, { LOKI_SPEED: "1" }, async (d) => { units = d.units.length; return 0; });
    expect(units).toBe(3);
    expect(r).toBe(0);
    expect(err).toBe("");
  });
  test("a provider without parallel slots falls back with the reason", async () => {
    let calls = 0;
    const { r, err } = await run(SPEC, { LOKI_SPEED: "1", LOKI_PROVIDER: "aider" }, async () => { calls++; return 0; });
    expect(r).toBeNull();
    expect(calls).toBe(0);
    expect(err).toContain("loki: sequential (reason: provider aider runs units sequentially)");
  });
  test("one unit falls back and says so", async () => {
    let calls = 0;
    const one = "- change src/a.ts\n- also touch src/a.ts again\n";
    const { r, err } = await run(one, { LOKI_SPEED: "1" }, async () => { calls++; return 0; });
    expect(r).toBeNull();
    expect(calls).toBe(0);
    expect(err).toContain("loki: sequential (reason: decomposer returned 1 unit)");
  });
  test("a group that throws returns non-zero and never falls back", async () => {
    let calls = 0;
    const { r, err } = await run(SPEC, ON, async () => { calls++; throw new Error("boom"); });
    expect(r).toBe(1);
    expect(calls).toBe(1);
    expect(err).toContain("loki: group run failed: boom");
    expect(err).not.toContain("sequential");
  });
  test("loki <file> reads the spec, passes contents and path, announces it", () => withDir(async (d) => {
    const p = join(d, "spec.md");
    writeFileSync(p, SPEC);
    let ctx: GroupCtx | null = null;
    const { r, err } = await run(p, ON, async (_g, c) => { ctx = c; return 7; }, d, d);
    expect(r).toBe(7);
    expect(ctx!.spec).toBe(SPEC);
    expect(ctx!.specPath!.endsWith("spec.md")).toBe(true);
    expect(err).toContain("loki: reading spec from ");
  }));
  test("relative spec path resolves against cwd, not the repo root", () => withDir(async (d) => {
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "sub", "spec.md"), SPEC);
    writeFileSync(join(d, "spec.md"), "- one\n");
    let units = 0;
    const { r } = await run("spec.md", ON, async (g) => { units = g.units.length; return 5; }, d, join(d, "sub"));
    expect(r).toBe(5);
    expect(units).toBe(3);
  }));
  test("a one-word existing file never shadows a literal task", () => withDir(async (d) => {
    writeFileSync(join(d, "TODO"), SPEC);
    writeFileSync(join(d, "-x"), SPEC);
    for (const w of ["TODO", "-x"]) {
      let calls = 0;
      const { r, task, err } = await run(w, ON, async () => { calls++; return 0; }, d, d);
      expect(r).toBeNull();
      expect(task).toBe(w);
      expect(calls).toBe(0);
      expect(err).toBe("");
    }
  }));
  test("a symlink escaping the repo is rejected and the task stays literal", () => withDir(async (d) => {
    const repo = join(d, "repo"), out = join(d, "outside");
    mkdirSync(repo); mkdirSync(out);
    writeFileSync(join(out, "secret.md"), SPEC);
    symlinkSync(join(out, "secret.md"), join(repo, "spec.md"));
    let calls = 0;
    const { r, task, err } = await run("spec.md", ON, async () => { calls++; return 0; }, repo, repo);
    expect(r).toBeNull();
    expect(task).toBe("spec.md");
    expect(calls).toBe(0);
    expect(err).toContain("escapes the repo");
    expect(err).toContain("loki: sequential");
  }));
  test("a spec over 1 MB falls back sequential with the reason", () => withDir(async (d) => {
    writeFileSync(join(d, "big.md"), SPEC + "x".repeat(MAX_SPEC_BYTES));
    const { r, task, err } = await run("big.md", ON, async () => 0, d, d);
    expect(r).toBeNull();
    expect(task).toBe("big.md");
    expect(err).toContain("loki: sequential (reason: spec file over");
  }));
  test("a spec containing NUL falls back sequential with the reason", () => withDir(async (d) => {
    writeFileSync(join(d, "nul.md"), Buffer.concat([Buffer.from(SPEC), Buffer.from([0])]));
    const { r, err } = await run("nul.md", ON, async () => 0, d, d);
    expect(r).toBeNull();
    expect(err).toContain("spec file contains NUL bytes");
  }));
  test("fallback after a file read hands the sequential run the spec contents", () => withDir(async (d) => {
    writeFileSync(join(d, "one.md"), "- change src/a.ts\n- also touch src/a.ts again\n");
    const { r, task } = await run("one.md", ON, async () => 0, d, d);
    expect(r).toBeNull();
    expect(task).toContain("change src/a.ts");
  }));
  test("a 200 KB spec falls back with a task of at most 64 KB (E2BIG guard)", () => withDir(async (d) => {
    const one = "- change src/a.ts\n" + "- also touch src/a.ts again\n".repeat(8000);
    writeFileSync(join(d, "big.md"), one);
    const { r, task } = await run("big.md", SEQ, undefined, d, d);
    expect(r).toBeNull();
    expect(Buffer.byteLength(task)).toBeLessThanOrEqual(MAX_SEQ_TASK_BYTES);
    expect(task).toBe("big.md");
  }));
  test("a 200 KB single-item spec also stays under the cap", () => withDir(async (d) => {
    writeFileSync(join(d, "big.md"), "x".repeat(200_000));
    const { task } = await run("big.md", ON, async () => 0, d, d);
    expect(Buffer.byteLength(task)).toBeLessThanOrEqual(MAX_SEQ_TASK_BYTES);
  }));
  test("LOKI_SPEED=0 returns the task unchanged even for an existing spec path", () => withDir(async (d) => {
    writeFileSync(join(d, "spec.md"), SPEC);
    const { r, task, err } = await run("spec.md", { LOKI_SPEED: "0" }, async () => 0, d, d);
    expect(r).toBeNull();
    expect(task).toBe("spec.md");
    expect(err).toBe("");
  }));
  test("an unreadable path-like argument writes one stderr note and stays literal", async () => {
    const { r, task, err } = await run("nope/missing.md", ON, async () => 0, "/x", "/x");
    expect(r).toBeNull();
    expect(task).toBe("nope/missing.md");
    expect(err.trim().split("\n").length).toBe(1);
    expect(err).toContain("spec path not readable");
  });
  test("default selection uses engine10 selectRelevantFiles, not a local copy", () => {
    expect(readFileSync(join(import.meta.dir, "../../src/features/speed/route.ts"), "utf8")).toContain('from "../../engine10/relevant_files.ts"');
  });
  test("a FIFO spec returns promptly with the literal path (open must not block)", async () => {
    await withDir(async (d) => {
      const p = join(d, "spec.md");
      if (spawnSync("mkfifo", [p]).status !== 0) return; // mkfifo missing: skip
      // A blocking open freezes the whole event loop, so probe in a child with a hard timeout.
      const code = `import { maybeRunGroup } from ${JSON.stringify(join(import.meta.dir, "../../src/features/speed/route.ts"))};
        const r = await maybeRunGroup(${JSON.stringify(p)}, ${JSON.stringify(d)}, { LOKI_SPEED: "1" }, { stderr: () => {}, cwd: ${JSON.stringify(d)} });
        process.exit(r.code === null && r.task === ${JSON.stringify(p)} ? 0 : 3);`;
      const res = spawnSync(process.execPath, ["-e", code], { timeout: 5000, killSignal: "SIGKILL" });
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(0);
    });
  });
  test("a readable spec over 64 KB falls back to the path with a stderr note", async () => {
    await withDir(async (d) => {
      const p = join(d, "big.md");
      writeFileSync(p, "- item a\n- item b\n" + "x".repeat(MAX_SEQ_TASK_BYTES + 10) + "\n");
      const { task, err } = await run(p, SEQ, undefined, d, d);
      expect(task).toBe(p);
      expect(err).toContain("spec over 64 KB, passing the path");
    });
  });
});

describe("default group runner (run_group.ts)", () => {
  const sh = (cwd: string, ...a: string[]): void => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); };
  const mkRepo = (d: string): void => {
    sh(d, "init", "-q", "-b", "main");
    sh(d, "config", "user.name", "t"); sh(d, "config", "user.email", "t@t.invalid"); sh(d, "config", "commit.gpgsign", "false");
    writeFileSync(join(d, "README.md"), "x\n"); sh(d, "add", "README.md"); sh(d, "commit", "-q", "-m", "init");
    sh(d, "remote", "add", "origin", "git@github.com:acme/widgets.git");
  };
  /** Fake backlog.py: records argv, creates a branch per unit (skipping those in failN), prints backlog status lines. */
  const launcher = (repo: string, seen: string[][], failN: number[] = [], code = 0) => async (argv: string[]) => {
    seen.push(argv);
    const g = argv[argv.indexOf("--group") + 1]!;
    let out = "";
    for (let n = 1; n <= 3; n++) {
      if (failN.includes(n)) { out += `backlog: unit-${g}-${n} FAILED: exit 1\n`; continue; }
      sh(repo, "checkout", "-q", "-b", `loki/unit-${g}-${n}`, "main");
      writeFileSync(join(repo, `u${n}.txt`), `${n}\n`); sh(repo, "add", `u${n}.txt`); sh(repo, "commit", "-q", "-m", `u${n}`);
      sh(repo, "checkout", "-q", "main");
      out += `backlog: unit-${g}-${n} VERIFIED\n`;
    }
    return { code, stdout: out };
  };
  const go = async (d: string, env: Record<string, string>, l: ReturnType<typeof launcher>) => {
    let err = "";
    const res = await maybeRunGroup(SPEC, d, { LOKI_SPEED: "1", LOKI_GROUP_TEST_CMD: "true", ...env } as NodeJS.ProcessEnv, { backlog: l, seal: { receiptSha256, verifyReceipt }, listFiles: () => files, select: sel, stderr: (s) => { err += s; } });
    return { code: res.code, err };
  };
  const slotsOf = (a: string[]): string | undefined => a[a.indexOf("--slots") + 1];
  test("no injected seal/verify: fails closed with NOT_PROVEN before any unit starts", async () => {
    await withDir(async (d) => {
      mkRepo(d);
      const seen: string[][] = [];
      let err = "";
      const res = await maybeRunGroup(SPEC, d, { LOKI_SPEED: "1", LOKI_GROUP_TEST_CMD: "true" } as NodeJS.ProcessEnv, { backlog: launcher(d, seen), listFiles: () => files, select: sel, stderr: (s) => { err += s; } });
      expect(res.code).toBe(4);
      expect(err).toContain("NOT PROVEN");
      expect(seen.length).toBe(0);
    });
  });
  test("claude: group runs with a slot cap, integrates, exit NOT_PROVEN (never 0: no group Seal)", async () => {
    await withDir(async (d) => {
      mkRepo(d);
      const seen: string[][] = [];
      const { code, err } = await go(d, { LOKI_PROVIDER: "claude" }, launcher(d, seen));
      expect(code).toBe(4);
      expect(err).toContain("NOT PROVEN");
      expect(seen.length).toBe(1);
      expect(seen[0]!).toContain("--dag");
      expect(slotsOf(seen[0]!)).toBe("3");
      expect(readFileSync(join(d, ".loki/groups", seen[0]![seen[0]!.indexOf("--group") + 1]!, "dag.json"), "utf8")).toContain("units");
    });
  });
  test("a unit whose sealed Wall copy is tampered is FAILED (exit 1); a missing receipt is NOT_PROVEN (exit 4) in the tests above", async () => {
    await withDir(async (d) => {
      mkRepo(d);
      const base = launcher(d, []);
      const tamper = async (argv: string[]) => {
        const res = await base(argv), g = argv[argv.indexOf("--group") + 1]!, run = join(d, ".loki/groups", g, "group/units", "u1");
        mkdirSync(join(run, "wall"), { recursive: true });
        writeFileSync(join(run, "wall", "loki_wall_a.test.ts"), "tampered");
        writeFileSync(join(run, "receipt.json"), JSON.stringify({ wall: { files: [{ path: `${d}-backlog/unit-${g}-1/loki_wall_a.test.ts`, sha256: "0".repeat(64) }] } }));
        return res;
      };
      const { code, err } = await go(d, { LOKI_PROVIDER: "claude" }, tamper);
      expect(code).toBe(1);
      expect(err).toContain("not the sealed bytes");
    });
  });
  test("--provider (deps.provider) caps slots and is forwarded to the units", async () => {
    await withDir(async (d) => {
      mkRepo(d);
      const seen: string[][] = [];
      const res = await maybeRunGroup(SPEC, d, { LOKI_SPEED: "1", LOKI_GROUP_TEST_CMD: "true" } as NodeJS.ProcessEnv, { provider: "codex", seal: { receiptSha256, verifyReceipt }, backlog: launcher(d, seen), listFiles: () => files, select: sel, stderr: () => {} });
      expect(res.code).toBe(4);
      expect(slotsOf(seen[0]!)).toBe("2");
      expect(seen[0]!.slice(seen[0]!.indexOf("--provider"))[1]).toBe("codex");
    });
  });
  test("--provider aider falls back even when LOKI_PROVIDER is unset", async () => {
    let calls = 0, err = "";
    const res = await maybeRunGroup(SPEC, "/nonexistent", { LOKI_SPEED: "1" } as NodeJS.ProcessEnv, { provider: "aider", group: async () => { calls++; return 0; }, listFiles: () => files, select: sel, stderr: (s) => { err += s; } });
    expect(res.code).toBeNull();
    expect(calls).toBe(0);
    expect(err).toContain("provider aider runs units sequentially");
  });
  test("a unit child (LOKI_UNIT_ID) never re-decomposes", async () => {
    let calls = 0;
    const res = await maybeRunGroup(SPEC, "/nonexistent", { LOKI_SPEED: "1", LOKI_UNIT_ID: "u1" } as NodeJS.ProcessEnv, { group: async () => { calls++; return 0; }, listFiles: () => files, select: sel, stderr: () => {} });
    expect(res.code).toBeNull();
    expect(calls).toBe(0);
  });
  test("codex: slots capped at 2", async () => {
    await withDir(async (d) => {
      mkRepo(d);
      const seen: string[][] = [];
      await go(d, { LOKI_PROVIDER: "codex" }, launcher(d, seen));
      expect(slotsOf(seen[0]!)).toBe("2");
    });
  });
  test("a failed unit never yields exit 0", async () => {
    await withDir(async (d) => {
      mkRepo(d);
      const { code, err } = await go(d, {}, launcher(d, [], [2], 1));
      expect(code).toBe(1);
      expect(err).toContain("group not verified");
    });
  });
  test("launcher non-zero with every unit reported passing is still not VERIFIED", async () => {
    await withDir(async (d) => {
      mkRepo(d);
      const { code } = await go(d, {}, launcher(d, [], [], 1));
      expect(code).toBe(1);
    });
  });
  test("a failing suite is not VERIFIED", async () => {
    await withDir(async (d) => {
      mkRepo(d);
      const { code } = await go(d, { LOKI_GROUP_TEST_CMD: "false" }, launcher(d, []));
      expect(code).toBe(1);
    });
  });
  test("no origin remote: no unit starts and the task runs as one local run (FC-GROUP-REFUSES-LOCAL-TASK-WITHOUT-ORIGIN)", async () => {
    await withDir(async (d) => {
      mkRepo(d); sh(d, "remote", "remove", "origin");
      const seen: string[][] = [];
      const { code, err } = await go(d, {}, launcher(d, seen));
      expect(code).toBeNull();
      expect(seen.length).toBe(0);
      expect(err).toContain("sequential (reason: no origin remote");
      expect(err).not.toContain("NOT PROVEN");
    });
  });
  test("LOKI_GROUP_TEST_CMD wins over a package.json test script", async () => {
    await withDir(async (d) => {
      mkRepo(d);
      const envMark = join(d, "env-ran.txt"), pkgMark = join(d, "pkg-ran.txt");
      writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x", scripts: { test: `touch ${pkgMark}` } }));
      sh(d, "add", "package.json"); sh(d, "commit", "-q", "-m", "pkg");
      const { code } = await go(d, { LOKI_GROUP_TEST_CMD: `touch ${envMark}` }, launcher(d, []));
      expect(code).toBe(4);
      expect(existsSync(envMark)).toBe(true);
      expect(existsSync(pkgMark)).toBe(false);
    });
  });
});

describe("missions: multi-milestone specs", () => {
  const MS = "# Plan\n\n## Milestone 1: scaffold\n- update src/a.ts to add alpha\n\n## Milestone 2: wire\nupdate src/b.ts to add beta\n\n## Milestone 3: ship\nupdate src/c.ts to add gamma\n";
  const rec = (codes: number[]) => {
    const seen: { units: number; spec: string }[] = [];
    const g: GroupRunner = async (dag, ctx) => { seen.push({ units: dag.units.length, spec: ctx.spec }); return codes[seen.length - 1] ?? 0; };
    return { seen, g };
  };
  test("milestones run in order, one group each, even on a sequential provider with 1-unit groups", async () => {
    const { seen, g } = rec([]);
    const { r, err } = await run(MS, SEQ, g);
    expect(r).toBe(0);
    expect(seen.map((s) => s.units)).toEqual([1, 1, 1]);
    expect(seen[1]!.spec).toContain("src/b.ts");
    expect(seen[1]!.spec).not.toContain("src/a.ts");
    expect(err).toContain("loki: milestone 1/3: scaffold");
    expect(err).toContain("loki: milestone 3/3: ship");
  });
  test("a failing milestone stops the mission, propagates its code, never starts the next", async () => {
    const { seen, g } = rec([0, 4]);
    const { r, err } = await run(MS, ON, g);
    expect(r).toBe(4);
    expect(seen.length).toBe(2);
    expect(err).toContain("loki: milestone 2/3 failed (exit 4); rerun the same loki start to resume");
  });
  test("one milestone is not a mission: normal path", async () => {
    const { seen, g } = rec([]);
    const { r } = await run("## Milestone 1: only\n" + SPEC, ON, g);
    expect(r).toBe(0);
    expect(seen.length).toBe(1);
    expect(seen[0]!.units).toBe(3);
  });
});

describe("a group run needs an origin remote; a local task without one runs sequentially (FC-GROUP-REFUSES-LOCAL-TASK-WITHOUT-ORIGIN)", () => {
  const gitRepo = (d: string, origin?: string): void => {
    spawnSync("git", ["init", "-q"], { cwd: d });
    if (origin) spawnSync("git", ["remote", "add", "origin", origin], { cwd: d });
  };
  const real = async (repo: string) => {
    let err = "";
    const res = await maybeRunGroup(SPEC, repo, { LOKI_SPEED: "1" } as NodeJS.ProcessEnv, { listFiles: () => files, select: sel, stderr: (s) => { err += s; } });
    return { r: res.code, task: res.task, err };
  };
  test("no origin: falls back to a sequential run and names the reason, not NOT PROVEN", async () => {
    await withDir(async (d) => {
      gitRepo(d);
      const { r, task, err } = await real(d);
      expect(r).toBeNull();
      expect(task).toBe(SPEC);
      expect(err).toContain("sequential (reason: no origin remote of the form owner/repo");
      expect(err).not.toContain("NOT PROVEN");
    });
  });
  test("control: an owner/repo origin still goes to the group runner", async () => {
    await withDir(async (d) => {
      gitRepo(d, "https://github.com/acme/widgets.git");
      const { r, err } = await real(d);
      expect(r).not.toBeNull();
      expect(err).not.toContain("sequential (reason: no origin remote");
    });
  });
  for (const [label, origin] of [["a local path origin (bench/fixture)", "bench/fixture"], ["an absolute local path origin", "/srv/bench/fixture"], ["a gitlab.com origin", "https://gitlab.com/acme/widgets.git"], ["a non-github ssh origin", "git@gitlab.com:acme/widgets.git"]] as const) {
    test(`${label}: sequential with the reason, not a failed group run`, async () => {
      await withDir(async (d) => {
        gitRepo(d, origin);
        const { r, task, err } = await real(d);
        expect(r).toBeNull();
        expect(task).toBe(SPEC);
        expect(err).toContain("sequential (reason: no origin remote of the form owner/repo on github.com");
        expect(err).not.toContain("no unit passed");
      });
    });
  }
  test("a github.com ssh origin without .git still goes to the group runner", async () => {
    await withDir(async (d) => {
      gitRepo(d, "git@github.com:acme/widgets");
      const { r, err } = await real(d);
      expect(r).not.toBeNull();
      expect(err).not.toContain("sequential (reason: no origin remote");
    });
  });
  test("a mission spec with no origin also falls back", async () => {
    await withDir(async (d) => {
      gitRepo(d);
      let err = "";
      const mission = "## Milestone 1: first\n" + SPEC + "\n## Milestone 2: second\n" + SPEC;
      const res = await maybeRunGroup(mission, d, { LOKI_SPEED: "1" } as NodeJS.ProcessEnv, { listFiles: () => files, select: sel, stderr: (s) => { err += s; } });
      expect(res.code).toBeNull();
      expect(err).toContain("sequential (reason: no origin remote");
    });
  });
});
