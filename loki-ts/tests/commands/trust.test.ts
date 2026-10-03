// loki-ts/tests/commands/trust.test.ts -- runTrust command wrapper contract.
//
// Covers: help forms (exit 0 + usage text), unknown-arg hint on stderr (exit 1),
// --json parseable output against an empty .loki, the writeTrajectoryCache side
// effect, a seeded two-run proofs fixture (non-flat trajectory), and the
// honest-data rule (fewer than 2 runs yields no fabricated trend).
//
// Hermetic: LOKI_DIR points at a tmpdir; stdout/stderr are monkey-patched.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runTrust } from "../../src/commands/trust.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  const dec = (c: unknown): string =>
    typeof c === "string" ? c : new TextDecoder().decode(c as Uint8Array);
  process.stdout.write = ((c: unknown): boolean => {
    out += dec(c);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown): boolean => {
    err += dec(c);
    return true;
  }) as typeof process.stderr.write;
  let code: number;
  try {
    code = runTrust(args);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { code, stdout: out, stderr: err };
}

let td: string;
let lokiDir: string;
let savedLokiDir: string | undefined;

function seedProof(runId: string, at: string, passed: number, total: number, iters: number): void {
  const d = join(lokiDir, "proofs", runId);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "proof.json"),
    JSON.stringify({
      run_id: runId,
      generated_at: at,
      council: { final_verdict: passed === total ? "APPROVED" : "REJECTED" },
      quality_gates: { total, passed },
      iterations: { count: iters },
    }),
  );
}

beforeEach(() => {
  td = mkdtempSync(join(tmpdir(), "loki-trust-cmd-"));
  lokiDir = join(td, ".loki");
  savedLokiDir = process.env["LOKI_DIR"];
  process.env["LOKI_DIR"] = lokiDir;
});
afterEach(() => {
  if (savedLokiDir === undefined) delete process.env["LOKI_DIR"];
  else process.env["LOKI_DIR"] = savedLokiDir;
  rmSync(td, { recursive: true, force: true });
});

describe("runTrust", () => {
  for (const flag of ["--help", "-h", "help"]) {
    it(`${flag} returns 0 and prints usage`, () => {
      const r = run([flag]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("visible trust trajectory");
      expect(r.stderr).toBe("");
    });
  }

  it("unknown arg returns 1 with the hint on stderr", () => {
    const r = run(["--bogus"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Run 'loki trust --help'");
    expect(r.stdout).toBe("");
  });

  it("--json on an empty .loki returns 0 with parseable insufficient JSON and writes the cache", () => {
    const r = run(["--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.runs_count).toBe(0);
    expect(j.insufficient).toBe(true);
    const cache = join(lokiDir, "metrics", "trust-trajectory.json");
    expect(existsSync(cache)).toBe(true);
    expect(JSON.parse(readFileSync(cache, "utf8")).runs_count).toBe(0);
  });

  it("one run yields no fabricated trend", () => {
    seedProof("run-a", "2026-01-01T00:00:00Z", 4, 8, 10);
    const r = run(["--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.runs_count).toBe(1);
    expect(j.insufficient).toBe(true);
    expect(j.improving_count).toBe(0);
    expect(j.regressing_count).toBe(0);
    expect(j.axes.gate_pass_rate.insufficient).toBe(true);
    expect(j.axes.gate_pass_rate.improving).not.toBe(true);
  });

  it("two seeded runs yield a non-flat improving trajectory", () => {
    seedProof("run-a", "2026-01-01T00:00:00Z", 4, 8, 10);
    seedProof("run-b", "2026-01-02T00:00:00Z", 8, 8, 4);
    const r = run(["--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.runs_count).toBe(2);
    expect(j.insufficient).toBe(false);
    expect(j.axes.gate_pass_rate.direction).toBe("up");
    expect(j.axes.gate_pass_rate.improving).toBe(true);
    expect(j.axes.iterations.direction).toBe("down");
    expect(j.axes.iterations.improving).toBe(true);
    expect(j.improving_axes).toContain("gate_pass_rate");
    const cached = JSON.parse(
      readFileSync(join(lokiDir, "metrics", "trust-trajectory.json"), "utf8"),
    );
    expect(cached.runs_count).toBe(2);
  });

  it("human mode prints non-empty text and returns 0", () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });
});
