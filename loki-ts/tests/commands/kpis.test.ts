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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runKpis } from "../../src/commands/kpis.ts";
import { mkdtempSync, rmSync } from "node:fs";
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
