// D61-16: LOKI_SPEED routing of `loki "<task>"` / `loki <file>` through the decomposer.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../../src/engine10/cli.ts";
import { maybeRunGroup, type GroupRunner } from "../../src/features/speed/route.ts";

const SPEC = "- update src/a.ts to add alpha\n- update src/b.ts to add beta\n- update src/c.ts to add gamma\n";
const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
const sel = (t: string): string[] => files.filter((f) => t.includes(f));
const run = async (task: string, env: Record<string, string | undefined>, group?: GroupRunner, repo = "/x") => {
  let err = "";
  const r = await maybeRunGroup(task, repo, env as NodeJS.ProcessEnv, { group, listFiles: () => files, select: sel, stderr: (s) => { err += s; } });
  return { r, err };
};

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
    const { r, err } = await run(SPEC, { LOKI_SPEED: "1" }, undefined);
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
  test("a group that throws falls back to the single run", async () => {
    const { r, err } = await run(SPEC, { LOKI_SPEED: "1" }, async () => { throw new Error("boom"); });
    expect(r).toBeNull();
    expect(err).toContain("loki: sequential (reason: group run failed to start");
  });
  test("loki <file> reads the spec from the file", async () => {
    const d = mkdtempSync(join(tmpdir(), "loki-route-group-"));
    try {
      const p = join(d, "spec.md");
      writeFileSync(p, SPEC);
      let units = 0;
      const { r } = await run(p, { LOKI_SPEED: "1" }, async (g) => { units = g.units.length; return 7; }, d);
      expect(units).toBe(3);
      expect(r).toBe(7);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
