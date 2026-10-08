// E-12: engine10 router and the one cli.ts dispatch arm.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { route, runEngine10 } from "../../src/engine10/cli.ts";

const SRC = join(import.meta.dir, "..", "..", "src");

function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; err: string }> {
  const orig = process.stderr.write.bind(process.stderr);
  let err = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return fn()
    .then((value) => ({ value, err }))
    .finally(() => {
      process.stderr.write = orig;
    });
}

describe("route", () => {
  test("named commands and hidden subcommands", () => {
    expect(route(["status", "r1"])).toEqual({ module: "status.ts", fn: "main", args: ["r1"] });
    expect(route(["verify"])?.module).toBe("verify_cmd.ts");
    expect(route(["dashboard"])?.module).toBe("../runner/engine10_dashboard.ts");
    expect(route(["worker", "x"])).toEqual({ module: "worker.ts", fn: "main", args: ["x"] });
    expect(route(["session"])?.module).toBe("session.ts");
    expect(route(["deep-supervise"])).toEqual({ module: "stages/deep.ts", fn: "deepSupervise", args: [] });
    expect(route(["deep-worker"])?.fn).toBe("deepWorker");
  });
  test("tasks, issue refs and flags go to the supervisor with every arg", () => {
    for (const a of [["fix x"], ["owner/repo#3"], ["https://github.com/o/r/issues/7"], ["--deep", "fix x"]]) {
      expect(route(a)).toEqual({ module: "supervisor.ts", fn: "main", args: a });
    }
  });
  test("empty and help invocations are not routed", () => {
    expect(route([])).toBeNull();
    expect(route(["--help"])).toBeNull();
  });
});

describe("runEngine10", () => {
  test("a missing module prints not built yet and exits 2", async () => {
    const load = async (spec: string) => {
      const e = new Error(`Cannot find module '${spec}' from '${SRC}/engine10/cli.ts'`) as Error & { code: string };
      e.code = "ERR_MODULE_NOT_FOUND";
      throw e;
    };
    const { value, err } = await captureStderr(() => runEngine10(["status"], load));
    expect(value).toBe(2);
    expect(err).toBe("engine10: status.ts not built yet\n");
  });

  test("the real loader reports a module that is absent on disk", async () => {
    const { value, err } = await captureStderr(() =>
      runEngine10(["status"], (s) => import(`${SRC}/engine10/__absent__/${s}`)),
    );
    expect(value).toBe(2);
    expect(err).toContain("not built yet");
  });

  test("a missing import inside an existing module is rethrown", async () => {
    const load = async () => {
      throw Object.assign(new Error(`Cannot find module './types.ts' from '${SRC}/engine10/status.ts'`), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    };
    await expect(runEngine10(["status"], load)).rejects.toThrow("types.ts");
  });

  test("dispatches to the export with the remaining args and returns its code", async () => {
    let seen = null as { spec: string; args: string[] } | null;
    const load = async (spec: string) => ({
      deepWorker: (args: string[]) => {
        seen = { spec, args };
        return 7;
      },
    });
    expect(await runEngine10(["deep-worker", "--run", "r1"], load)).toBe(7);
    expect(seen).toEqual({ spec: "./stages/deep.ts", args: ["--run", "r1"] });
  });

  test("a module without the export exits 2", async () => {
    // LOKI_SPEED=0: the speed path probes the host warm socket (~/.loki/run/engine.sock) before loading supervisor.ts.
    const prev = process.env.LOKI_SPEED; process.env.LOKI_SPEED = "0";
    try {
      const { value, err } = await captureStderr(() => runEngine10(["fix x"], async () => ({})));
      expect(value).toBe(2);
      expect(err).toContain("supervisor.ts does not export main");
    } finally { if (prev === undefined) delete process.env.LOKI_SPEED; else process.env.LOKI_SPEED = prev; }
  });
});

describe("static shape", () => {
  test("the router imports no sibling module statically", () => {
    const text = readFileSync(join(SRC, "engine10", "cli.ts"), "utf8");
    expect(text).not.toMatch(/^\s*import\s[^(]/m);
    expect(text).not.toMatch(/^\s*export\s.*\sfrom\s/m);
  });

  test("engine10 appears only in the one cli.ts arm", () => {
    const lines = readFileSync(join(SRC, "cli.ts"), "utf8").split("\n");
    // The HELP row that documents the command (PO4-CLI-TS-HELP) is text, not routing.
    const helpRow = /^\s*engine10 <subcmd>\s/;
    const hits = lines.flatMap((l, i) => (l.includes("engine10") && !helpRow.test(l) ? [i] : []));
    expect(lines.filter((l) => helpRow.test(l)).length).toBe(1);
    // E-32: the arm also loads the static registry so dist can reach every module.
    expect(hits.length).toBe(3);
    expect(lines[hits[0]!]!.trim()).toBe('case "engine10": {');
    expect(lines[hits[1]!]!.trim()).toBe('const { runEngine10 } = await import("./engine10/cli.ts");');
    expect(lines[hits[2]!]!.trim()).toBe('const { registryLoader } = await import("./engine10/registry.ts");');
    expect(hits).toEqual([hits[0]!, hits[0]! + 1, hits[0]! + 2]);
    // D91: contrib/index.ts fills core's hook slots before the engine runs; core never imports contrib.
    expect(lines[hits[0]! + 3]!.trim()).toBe('(await import("./contrib/index.ts")).registerContrib();');
    expect(lines[hits[0]! + 4]!.trim()).toBe("return runEngine10(rest, registryLoader);");
  });

  test("the issues arm registers contrib before its planning sessions run", () => {
    const lines = readFileSync(join(SRC, "cli.ts"), "utf8").split("\n");
    const at = lines.findIndex((l) => l.trim() === 'case "issues": {');
    expect(at).toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > at && l.trim() === "}");
    const arm = lines.slice(at, end + 1).map((l) => l.trim());
    const reg = arm.indexOf('(await import("./contrib/index.ts")).registerContrib();');
    expect(reg).toBeGreaterThan(-1);
    expect(reg).toBeLessThan(arm.indexOf("return runIssues(rest);"));
  });
});
