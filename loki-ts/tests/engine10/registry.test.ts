// E-32: registration guard. A module that the stage table or the cli TABLE names,
// and that exists on disk, must be in the static registry, or the npm package
// (dist only) silently skips it.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FLOW } from "../../src/engine10/machine.ts";
import { route } from "../../src/engine10/cli.ts";
import { REGISTRY, registryLoader } from "../../src/engine10/registry.ts";

const DIR = join(import.meta.dir, "../../src/engine10");
const onDisk = (spec: string): boolean => existsSync(join(DIR, spec));

const stageSpecs = [...FLOW.flat(), "fix", "deep"].map((n) => `./stages/${n}.ts`);
const cliText = readFileSync(join(DIR, "cli.ts"), "utf8");
const tableSpecs = [...cliText.matchAll(/module:\s*"([^"]+)"/g)].map((m) => `./${m[1]}`);
const runSpec = `./${route(["some task"])!.module}`;
const named = [...new Set([...stageSpecs, ...tableSpecs, runSpec, "./../contrib/eta.ts"])];

describe("engine10 registry", () => {
  test("names are found (the guard is not vacuous)", () => {
    expect(tableSpecs).toContain("./session.ts");
    expect(stageSpecs).toContain("./stages/wall.ts");
    expect(named.filter(onDisk).length).toBeGreaterThan(10);
  });

  test("every named module present on disk is registered", () => {
    const missing = named.filter((s) => onDisk(s) && !(s in REGISTRY));
    expect(missing).toEqual([]);
  });

  test("every registry entry exists on disk", () => {
    expect(Object.keys(REGISTRY).filter((s) => !onDisk(s))).toEqual([]);
  });

  // Which export each stage offers (stage vs <name>Stage) is E-42's fix; here we
  // only prove every literal import resolves.
  test("every registry entry loads", async () => {
    for (const s of Object.keys(REGISTRY)) {
      expect(Object.keys(await registryLoader(s)).length).toBeGreaterThan(0);
    }
  });

  test("an unregistered specifier rejects like a missing module", async () => {
    const err = (await registryLoader("./nope.ts").catch((e) => e)) as { code?: string; message?: string };
    expect(err.code).toBe("ERR_MODULE_NOT_FOUND");
    expect(err.message).toContain("./nope.ts");
  });
});

describe("engine10 production routing through registryLoader", () => {
  // src/cli.ts runs `runEngine10(rest, registryLoader)`; tests that call main() directly miss a missing row.
  test("export-sarif resolves via the registry and --help exits 0", async () => {
    const { runEngine10 } = await import("../../src/engine10/cli.ts");
    const err: string[] = [];
    const out: string[] = [];
    const w1 = process.stderr.write.bind(process.stderr);
    const w2 = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((s: string) => (err.push(String(s)), true)) as typeof process.stderr.write;
    process.stdout.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
    let rc: number;
    try {
      rc = await runEngine10(["export-sarif", "--help"], registryLoader);
    } finally {
      process.stderr.write = w1;
      process.stdout.write = w2;
    }
    expect(err.join("")).not.toContain("not built yet");
    expect(rc).toBe(0);
  });
});
