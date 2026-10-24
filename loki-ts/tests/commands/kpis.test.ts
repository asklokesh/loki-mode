// loki-ts/tests/commands/kpis.test.ts -- CLI consolidation Phase B (v7.31).
//
// Covers the `runKpis` command wrapper, specifically the deprecated-alias
// contract added in Phase B (kpis -> report kpis):
//  - canonical `report kpis` (runKpis with no aliasOf): NO stderr pointer.
//  - deprecated `kpis` alias (runKpis with aliasOf:"kpis"): exactly ONE stderr
//    pointer line "is now 'loki report kpis'".
//  - --json, -q, --quiet suppress the pointer on the alias (machine-output
//    contract) and are tolerated (no "unknown arg" error), matching the bash
//    route which only special-cases --json and ignores the rest.
//  - --help on either form returns 0 and prints the canonical usage.
//
// Hermetic: each test sets LOKI_DIR to a tmpdir so computeKpis reads no real
// state. process.stdout/stderr are monkey-patched per-test because runKpis
// writes directly to them (mirrors the bash route's echo).

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { runKpis } from "../../src/commands/kpis.ts";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Capture = { stdout: string; stderr: string };

function captureIO(): { restore: () => void; get: () => Capture } {
  const orig = {
    out: process.stdout.write.bind(process.stdout),
    err: process.stderr.write.bind(process.stderr),
  };
  let out = "";
  let err = "";
  process.stdout.write = ((chunk: unknown): boolean => {
    out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    err += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array);
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: () => {
      process.stdout.write = orig.out;
      process.stderr.write = orig.err;
    },
    get: () => ({ stdout: out, stderr: err }),
  };
}

const POINTER = "is now 'loki report kpis'";

let td: string;
let savedLokiDir: string | undefined;

beforeEach(() => {
  td = mkdtempSync(join(tmpdir(), "loki-kpis-cmd-"));
  savedLokiDir = process.env["LOKI_DIR"];
  process.env["LOKI_DIR"] = join(td, ".loki");
});
afterEach(() => {
  if (savedLokiDir === undefined) delete process.env["LOKI_DIR"];
  else process.env["LOKI_DIR"] = savedLokiDir;
  rmSync(td, { recursive: true, force: true });
});

describe("runKpis alias contract (Phase B)", () => {
  it("canonical (no aliasOf) emits NO deprecation pointer", () => {
    const io = captureIO();
    let code: number;
    try {
      code = runKpis([]);
    } finally {
      io.restore();
    }
    const { stdout, stderr } = io.get();
    expect(code).toBe(0);
    expect(stderr).not.toContain(POINTER);
    expect(stdout).toContain("Loki Mode KPIs");
  });

  it("alias (aliasOf:kpis) emits exactly one deprecation pointer to stderr", () => {
    const io = captureIO();
    let code: number;
    try {
      code = runKpis([], { aliasOf: "kpis" });
    } finally {
      io.restore();
    }
    const { stdout, stderr } = io.get();
    expect(code).toBe(0);
    const occurrences = stderr.split(POINTER).length - 1;
    expect(occurrences).toBe(1);
    expect(stderr).toContain("note: 'loki kpis'");
    expect(stdout).toContain("Loki Mode KPIs");
  });

  it("alias --json suppresses the pointer and emits parseable JSON", () => {
    const io = captureIO();
    let code: number;
    try {
      code = runKpis(["--json"], { aliasOf: "kpis" });
    } finally {
      io.restore();
    }
    const { stdout, stderr } = io.get();
    expect(code).toBe(0);
    expect(stderr).not.toContain(POINTER);
    const parsed = JSON.parse(stdout) as { schema_version?: number };
    expect(parsed.schema_version).toBe(1);
  });

  it("alias -q and --quiet suppress the pointer and are tolerated (no unknown-arg error)", () => {
    for (const flag of ["-q", "--quiet"]) {
      const io = captureIO();
      let code: number;
      try {
        code = runKpis([flag], { aliasOf: "kpis" });
      } finally {
        io.restore();
      }
      const { stdout, stderr } = io.get();
      expect(code).toBe(0);
      expect(stderr).not.toContain(POINTER);
      expect(stderr).not.toContain("unknown arg");
      expect(stdout).toContain("Loki Mode KPIs");
    }
  });

  it("--help returns 0 and prints the canonical `report kpis` usage on both forms", () => {
    for (const opts of [{}, { aliasOf: "kpis" }]) {
      const io = captureIO();
      let code: number;
      try {
        code = runKpis(["--help"], opts);
      } finally {
        io.restore();
      }
      const { stdout } = io.get();
      expect(code).toBe(0);
      expect(stdout).toContain("loki report kpis");
    }
  });

  it("rejects a genuinely unknown arg with exit 1 (parser still strict)", () => {
    const io = captureIO();
    let code: number;
    try {
      code = runKpis(["--bogus"]);
    } finally {
      io.restore();
    }
    const { stderr } = io.get();
    expect(code).toBe(1);
    expect(stderr).toContain("unknown arg: --bogus");
  });
});

describe("runKpis --since window (TEN-COST-31)", () => {
  const DAY = 86_400_000;
  function seed(): void {
    const dir = join(td, ".loki", "metrics", "efficiency");
    mkdirSync(dir, { recursive: true });
    const iso = (ago: number): string => new Date(Date.now() - ago).toISOString();
    // old: 30d ago, $1.00; recent: 1d ago, $0.25 (explicit timestamps)
    writeFileSync(join(dir, "iteration-1.json"), JSON.stringify({ iteration: 1, status: "success", cost_usd: 1, input_tokens: 1000, output_tokens: 100, timestamp: iso(30 * DAY) }));
    writeFileSync(join(dir, "iteration-2.json"), JSON.stringify({ iteration: 2, status: "success", cost_usd: 0.25, input_tokens: 50, output_tokens: 5, timestamp: iso(1 * DAY) }));
    // no timestamp (Bun writer): falls back to mtime, aged to 20d ago
    const p = join(dir, "iteration-3.json");
    writeFileSync(p, JSON.stringify({ iteration: 3, status: "success", cost_usd: 2, input_tokens: 10, output_tokens: 1 }));
    const old = new Date(Date.now() - 20 * DAY);
    utimesSync(p, old, old);
  }
  function run(args: string[]): { code: number; stdout: string; stderr: string } {
    const io = captureIO();
    let code: number;
    try {
      code = runKpis(args);
    } finally {
      io.restore();
    }
    return { code, ...io.get() };
  }

  it("--since 7d excludes older iterations from cost and tokens (timestamp and mtime fallback)", () => {
    seed();
    const r = run(["--since", "7d", "--json"]);
    expect(r.code).toBe(0);
    const e = (JSON.parse(r.stdout) as { efficiency: { iteration_count: number; total_cost_usd: number; total_input_tokens: number } }).efficiency;
    expect(e.iteration_count).toBe(1);
    expect(e.total_cost_usd).toBe(0.25);
    expect(e.total_input_tokens).toBe(50);
  });

  it("since skips old runs: files older than the cutoff are never read, output identical", () => {
    seed();
    const dir = join(td, ".loki", "metrics", "efficiency");
    const spy = spyOn(fs, "readFileSync");
    let r: { code: number; stdout: string; stderr: string };
    try {
      r = run(["--since", "7d", "--json"]);
      const read = spy.mock.calls.map((c) => String(c[0])).filter((f) => f.startsWith(dir));
      expect(read.some((f) => f.endsWith("iteration-3.json"))).toBe(false);
      expect(read.some((f) => f.endsWith("iteration-2.json"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const e = (JSON.parse(r.stdout) as { efficiency: { iteration_count: number; total_cost_usd: number } }).efficiency;
    expect(e.iteration_count).toBe(1);
    expect(e.total_cost_usd).toBe(0.25);
  });

  it("without --since all iterations count", () => {
    seed();
    const e = (JSON.parse(run(["--json"]).stdout) as { efficiency: { iteration_count: number; total_cost_usd: number } }).efficiency;
    expect(e.iteration_count).toBe(3);
    expect(e.total_cost_usd).toBe(3.25);
  });

  it("window boundary: 25d keeps the mtime-aged 20d record, 10d drops it", () => {
    seed();
    const n = (a: string): number => (JSON.parse(run(["--since", a, "--json"]).stdout) as { efficiency: { iteration_count: number } }).efficiency.iteration_count;
    expect(n("25d")).toBe(2);
    expect(n("10d")).toBe(1);
  });

  it("human output names the window; --since=YYYY-MM-DD form works", () => {
    seed();
    const r = run(["--since=2020-01-02"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("since 2020-01-02");
    expect(r.stdout).toContain("Iterations:           3");
  });

  it("since missing value: names the flag, exits 1, never swallows the next flag", () => {
    for (const bad of [["--since"], ["--since", "--json"], ["--json", "--since"], ["--since", "--quiet"], ["--since", "-q"]]) {
      const r = run(bad);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--since requires a value");
      expect(r.stderr).not.toContain("''");
    }
    expect(run(["--since", "7d", "--json"]).code).toBe(0);
    expect(run(["--since=7d", "--json"]).code).toBe(0);
  });

  it("bad, missing, or impossible values exit 1 and say so", () => {
    for (const bad of [["--since", "banana"], ["--since", "7"], ["--since", "2026-02-31"], ["--since", "-3d"]]) {
      const r = run(bad);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("invalid --since value");
    }
  });
});

describe("runKpis cache saved", () => {
  function seed(records: object[]): void {
    const dir = join(td, ".loki", "metrics", "efficiency");
    mkdirSync(dir, { recursive: true });
    records.forEach((r, i) => writeFileSync(join(dir, `iteration-${i + 1}.json`), JSON.stringify({ iteration: i + 1, status: "success", ...r })));
  }
  function run(args: string[]): string {
    const io = captureIO();
    try { runKpis(args); } finally { io.restore(); }
    return io.get().stdout;
  }
  it("cache saved: reports cache read tokens and saved dollars (tokens times the price delta)", () => {
    seed([{ model: "sonnet", input_tokens: 10, output_tokens: 1, cache_read_tokens: 1_000_000 }]);
    const e = (JSON.parse(run(["--json"])) as { efficiency: { total_cache_read_tokens: number | null; cache_saved_usd: number | null } }).efficiency;
    expect(e.total_cache_read_tokens).toBe(1_000_000);
    expect(e.cache_saved_usd).toBe(1.9);
    expect(run([])).toContain("Cache saved USD:");
  });
  it("cache saved: measured 0 shows 0, a record without the key shows not measured", () => {
    seed([{ model: "sonnet", input_tokens: 10, output_tokens: 1, cache_read_tokens: 0 }]);
    const z = (JSON.parse(run(["--json"])) as { efficiency: { cache_saved_usd: number | null } }).efficiency;
    expect(z.cache_saved_usd).toBe(0);
    seed([{ model: "sonnet", input_tokens: 10, output_tokens: 1 }]);
    const u = (JSON.parse(run(["--json"])) as { efficiency: { cache_saved_usd: number | null; total_cache_read_tokens: number | null } }).efficiency;
    expect(u.cache_saved_usd).toBeNull();
    expect(u.total_cache_read_tokens).toBeNull();
    expect(run([])).toContain("Cache saved USD:      not measured");
  });
});
