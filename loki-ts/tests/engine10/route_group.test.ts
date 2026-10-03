// D61-16: LOKI_SPEED routing of `loki "<task>"` / `loki <file>` through the decomposer.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../../src/engine10/cli.ts";
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

describe("flag off is byte-identical", () => {
  test("route result and no group call for flag unset, LOKI_SPEED=0 and empty", async () => {
    const before = route(["fix x"]);
    let calls = 0;
    const g: GroupRunner = async () => { calls++; return 0; };
    for (const env of [{}, { LOKI_SPEED: "0" }, { LOKI_SPEED: "" }]) {
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
    expect(s).toMatch(/LOKI_SPEED === "1" && !isIssue[^\n]*speed\/route\.ts/);
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
  test("group machinery unavailable falls back and says so on stderr", async () => {
    const { r, err } = await run(SPEC, ON, undefined);
    expect(r).toBeNull();
    expect(err).toContain("loki: sequential (reason: group machinery unavailable)");
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
    const { r, task } = await run("big.md", ON, undefined, d, d);
    expect(r).toBeNull();
    expect(Buffer.byteLength(task)).toBeLessThanOrEqual(MAX_SEQ_TASK_BYTES);
    expect(task).toBe("big.md");
  }));
  test("a 200 KB single-item spec also stays under the cap", () => withDir(async (d) => {
    writeFileSync(join(d, "big.md"), "x".repeat(200_000));
    const { task } = await run("big.md", ON, async () => 0, d, d);
    expect(Buffer.byteLength(task)).toBeLessThanOrEqual(MAX_SEQ_TASK_BYTES);
  }));
  test("flag unset returns the task unchanged even for an existing spec path", () => withDir(async (d) => {
    writeFileSync(join(d, "spec.md"), SPEC);
    const { r, task, err } = await run("spec.md", {}, async () => 0, d, d);
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
});
