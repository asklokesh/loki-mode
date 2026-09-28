// M-07: `loki modernize` CLI and flag parsing; TABLE route in engine10/cli.ts.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../../../src/engine10/cli.ts";
import { main, parseArgs } from "../../../src/engine10/modernize/cli.ts";
import { modernizeEventsPath } from "../../../src/engine10/modernize/types.ts";

const PY_FIXTURE = join(import.meta.dir, "fixtures", "py");

function captureStd() {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  process.stdout.write = ((c: string | Uint8Array) => { out += String(c); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err += String(c); return true; }) as typeof process.stderr.write;
  return {
    restore: () => { process.stdout.write = origOut; process.stderr.write = origErr; },
    get out() { return out; },
    get err() { return err; },
  };
}

describe("route", () => {
  it("engine10/cli.ts routes modernize to modernize/cli.ts main, via a module string", () => {
    expect(route(["modernize", "/tmp/repo", "--to", "python3"])).toEqual({
      module: "modernize/cli.ts", fn: "main", args: ["/tmp/repo", "--to", "python3"],
    });
  });
});

describe("parseArgs", () => {
  it("parses every flag", () => {
    const r = parseArgs([
      "/repo", "--to", "python3", "--budget", "50", "--workers", "8", "--remote", "https://x",
      "--dry-run", "--provider", "claude", "--no-pr",
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.opts).toEqual({
      repoDir: "/repo", target: "python3", budgetUsd: 50, workers: 8, remote: "https://x",
      resume: null, dryRun: true, provider: "claude", noPr: true,
    });
  });

  it("defaults workers to 4 and budget/remote/resume/provider to null", () => {
    const r = parseArgs(["/repo", "--to", "java21"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.opts.workers).toBe(4);
    expect(r.opts.budgetUsd).toBeNull();
    expect(r.opts.dryRun).toBe(false);
  });

  it("rejects a missing repo", () => {
    const r = parseArgs(["--to", "python3"]);
    expect(r).toEqual({ ok: false, error: "missing <repo>" });
  });

  it("rejects a missing --to", () => {
    const r = parseArgs(["/repo"]);
    expect(r).toEqual({ ok: false, error: "missing --to" });
  });

  it("rejects an unknown target and lists the supported ones", () => {
    const r = parseArgs(["/repo", "--to", "cobol"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("python3");
    expect(r.error).toContain("java21");
  });

  it("rejects a non-positive --budget", () => {
    expect(parseArgs(["/repo", "--to", "python3", "--budget", "0"]).ok).toBe(false);
    expect(parseArgs(["/repo", "--to", "python3", "--budget", "-5"]).ok).toBe(false);
    expect(parseArgs(["/repo", "--to", "python3", "--budget", "nope"]).ok).toBe(false);
  });

  it("rejects a non-positive-integer --workers", () => {
    expect(parseArgs(["/repo", "--to", "python3", "--workers", "0"]).ok).toBe(false);
    expect(parseArgs(["/repo", "--to", "python3", "--workers", "2.5"]).ok).toBe(false);
  });

  it("caps local --workers at 32 without --remote", () => {
    const r = parseArgs(["/repo", "--to", "python3", "--workers", "33"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("32");
  });

  it("allows --workers over 32 when --remote is set", () => {
    const r = parseArgs(["/repo", "--to", "python3", "--workers", "64", "--remote", "https://x"]);
    expect(r.ok).toBe(true);
  });

  it("rejects a malformed --resume id", () => {
    const r = parseArgs(["/repo", "--to", "python3", "--resume", "not-an-id"]);
    expect(r.ok).toBe(false);
  });

  it("accepts a well-formed --resume id", () => {
    const r = parseArgs(["/repo", "--to", "python3", "--resume", "mod-20260928T010203Z-ab12cd"]);
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown flag and a flag needing a value at end of input", () => {
    expect(parseArgs(["/repo", "--to", "python3", "--bogus"]).ok).toBe(false);
    expect(parseArgs(["/repo", "--to"]).ok).toBe(false);
  });

  it("rejects a second positional argument", () => {
    const r = parseArgs(["/repo", "/other", "--to", "python3"]);
    expect(r.ok).toBe(false);
  });
});

describe("main", () => {
  let repoDir = "";
  beforeEach(() => { repoDir = mkdtempSync(join(tmpdir(), "e10-mod-cli-")); });
  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    // A failing assertion above must not leave .loki/ inside the committed py fixture.
    rmSync(join(PY_FIXTURE, ".loki"), { recursive: true, force: true });
  });

  it("a nonexistent <repo> path exits 2 instead of a false 'units: 0' green", async () => {
    const cap = captureStd();
    const code = await main([join(repoDir, "does-not-exist"), "--to", "python3", "--dry-run"]);
    cap.restore();
    expect(code).toBe(2);
    expect(cap.err).toContain("not a directory");
    expect(cap.out).toBe("");
  });

  it("--help prints usage and exits 0; no args prints usage and exits 2", async () => {
    const cap = captureStd();
    const helpCode = await main(["--help"]);
    const emptyCode = await main([]);
    cap.restore();
    expect(helpCode).toBe(0);
    expect(emptyCode).toBe(2);
    expect(cap.out).toContain("loki modernize <repo>");
  });

  it("a parse error goes to stderr with usage, exit 2", async () => {
    const cap = captureStd();
    const code = await main([repoDir]); // no --to
    cap.restore();
    expect(code).toBe(2);
    expect(cap.err).toContain("missing --to");
  });

  it("an unbuilt language module reports its gap honestly and exits 2, no fabricated estimate", async () => {
    // M-04 (lang/java.ts) has since landed for real, so this simulates the still-unbuilt
    // case via deps.load rather than relying on java21 itself being unbuilt.
    const missingLoad = async (spec: string) =>
      Promise.reject(Object.assign(new Error(`Cannot find module '${spec}'`), { code: "ERR_MODULE_NOT_FOUND" }));
    const cap = captureStd();
    const code = await main([repoDir, "--to", "java21"], { makeId: () => "mod-20260928T000000Z-000001", load: missingLoad });
    cap.restore();
    expect(code).toBe(2);
    expect(cap.err).toContain("lang/java.ts");
    expect(cap.err).toContain("not built yet");
    expect(cap.out).toBe(""); // never prints units/waves/cost for a graph it could not build
  });

  it("python3 --dry-run prints the estimate, exits 0, and logs the three events", async () => {
    const mid = "mod-20260928T000000Z-000002";
    const cap = captureStd();
    const code = await main([PY_FIXTURE, "--to", "python3", "--dry-run"], { makeId: () => mid });
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out).toContain("units:");
    expect(cap.out).toContain("waves:");
    expect(cap.out).toContain("risk:");

    const eventsPath = modernizeEventsPath(PY_FIXTURE, mid);
    expect(existsSync(eventsPath)).toBe(true);
    const types = readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
    expect(types).toEqual(["modernize.started", "inventory.completed", "estimate.printed"]);
  });

  it("python3 without --dry-run prints the estimate then stops before oracle capture (not built yet)", async () => {
    const mid = "mod-20260928T000000Z-000003";
    const cap = captureStd();
    const code = await main([PY_FIXTURE, "--to", "python3"], { makeId: () => mid });
    cap.restore();
    expect(code).toBe(2);
    expect(cap.out).toContain("units:"); // the estimate is real work already done, not withheld
    expect(cap.err).toContain("not built yet");
  });

  it("--resume reuses the given modernization id instead of minting a new one", async () => {
    const mid = "mod-20260928T010203Z-ab12cd";
    const cap = captureStd();
    await main([PY_FIXTURE, "--to", "python3", "--dry-run", "--resume", mid]);
    cap.restore();
    expect(existsSync(modernizeEventsPath(PY_FIXTURE, mid))).toBe(true);
  });

  it("an injected java graph builder is used when present", async () => {
    const mid = "mod-20260928T000000Z-000004";
    const cap = captureStd();
    const code = await main([repoDir, "--to", "java21", "--dry-run"], {
      makeId: () => mid,
      load: async () => ({ buildJavaGraph: async () => ({ graph: { nodes: [], edges: [] } }) }),
    });
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out).toContain("units: 0");
  });
});
