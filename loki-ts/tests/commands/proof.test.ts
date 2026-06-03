// Bash-vs-Bun parity tests for `loki proof` (R1, SLICE B).
//
// The bin/loki shim allowlist includes "proof" (bin/loki line ~119), so when
// bun is installed the Bun route (loki-ts/src/commands/proof.ts) is LIVE. The
// bash cmd_proof (autonomy/loki) is the fallback for no-bun systems and the
// LOKI_LEGACY_BASH=1 escape hatch. Divergences between the two are user-visible,
// so this file asserts byte-equal stdout + matching exit codes for `list` and
// equivalent JSON for `show`, including these edge cases the council flagged:
//   - empty proofs dir: BOTH print "No proofs found" with NO header row.
//   - null fields (final_verdict/cost.usd/count): BOTH render "-", not "None".
//
// Parity is taken over the source routes (bun src/cli.ts vs autonomy/loki),
// not the dist build, so a stale dist/loki.js cannot mask a source regression.
// NO_COLOR=1 is set for both spawns: both routes honor it (colors.ts:9,
// autonomy/loki:37) so the colored "No proofs found" line is byte-comparable.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { run } from "../../src/util/shell.ts";
import { runProof } from "../../src/commands/proof.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const BUN_CLI = resolve(REPO_ROOT, "loki-ts", "src", "cli.ts");
const BASH_CLI = resolve(REPO_ROOT, "autonomy", "loki");

let scratch = "";
let originalLokiDir: string | undefined;

// Both routes resolve the proofs dir from LOKI_DIR. An absolute scratch path
// means the spawned subprocesses' cwd is irrelevant.
function bunRoute(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run(["bun", BUN_CLI, ...argv], {
    env: { LOKI_DIR: scratch, NO_COLOR: "1" },
    timeoutMs: 30000,
  });
}

function bashRoute(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run([BASH_CLI, ...argv], {
    env: { LOKI_DIR: scratch, NO_COLOR: "1" },
    timeoutMs: 30000,
  });
}

function seedProof(id: string, proof: Record<string, unknown>): void {
  const dir = join(scratch, "proofs", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proof.json"), JSON.stringify(proof, null, 2));
}

// A full proof with only ASCII strings, integers, and a clean decimal. Avoids
// the python-str-vs-JS-String divergences (booleans -> True/true, floats like
// 1.0 -> "1.0"/"1") that would break byte-equality of the `list` row.
const FULL_PROOF = {
  run_id: "run-20260603-abc123",
  generated_at: "2026-06-03T12:00:00Z",
  council: { final_verdict: "APPROVE" },
  cost: { usd: "0.42" },
  files_changed: { count: 7 },
  redaction: { applied: "true", rules_version: "1", redactions_count: 3 },
};

// A degraded proof with explicitly-null fields. Pre-fix, bash rendered these
// as "None" (str(None)) while Bun rendered "-". Both must now render "-".
const NULL_PROOF = {
  run_id: "run-20260603-null01",
  generated_at: "2026-06-03T13:00:00Z",
  council: { final_verdict: null },
  cost: { usd: null },
  files_changed: { count: null },
};

beforeEach(() => {
  originalLokiDir = process.env["LOKI_DIR"];
  scratch = mkdtempSync(join(tmpdir(), "loki-proof-parity-"));
});

afterEach(() => {
  if (originalLokiDir === undefined) delete process.env["LOKI_DIR"];
  else process.env["LOKI_DIR"] = originalLokiDir;
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

describe("loki proof: bash vs Bun parity (list)", () => {
  it("empty proofs dir: both print 'No proofs found' with NO header, exit 0", async () => {
    mkdirSync(join(scratch, "proofs"), { recursive: true });
    const a = await bunRoute(["proof", "list"]);
    const b = await bashRoute(["proof", "list"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain("No proofs found");
    expect(a.stdout).not.toContain("RUN_ID");
    expect(b.stdout).not.toContain("RUN_ID");
  });

  it("missing proofs dir: both print 'No proofs found', exit 0", async () => {
    // No proofs/ dir created at all.
    const a = await bunRoute(["proof", "list"]);
    const b = await bashRoute(["proof", "list"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain("No proofs found");
  });

  it("full proof: both render identical header + row, exit 0", async () => {
    seedProof("run-20260603-abc123", FULL_PROOF);
    const a = await bunRoute(["proof", "list"]);
    const b = await bashRoute(["proof", "list"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain("RUN_ID");
    expect(a.stdout).toContain("run-20260603-abc123");
    expect(a.stdout).toContain("APPROVE");
  });

  it("null fields: both render '-' (not 'None'), identical output, exit 0", async () => {
    seedProof("run-20260603-null01", NULL_PROOF);
    const a = await bunRoute(["proof", "list"]);
    const b = await bashRoute(["proof", "list"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).not.toContain("None");
    expect(b.stdout).not.toContain("None");
    // run_id (non-null) followed by null verdict/cost/count all as "-".
    expect(a.stdout).toContain("run-20260603-null01");
    expect(a.stdout).toMatch(/-\s+-\s+-/);
  });

  it("multiple proofs (full + null): identical sorted output, exit 0", async () => {
    seedProof("run-20260603-abc123", FULL_PROOF);
    seedProof("run-20260603-null01", NULL_PROOF);
    const a = await bunRoute(["proof", "list"]);
    const b = await bashRoute(["proof", "list"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });
});

describe("loki proof: bash vs Bun parity (show)", () => {
  it("valid id: both emit equivalent JSON, exit 0", async () => {
    seedProof("run-20260603-abc123", FULL_PROOF);
    const a = await bunRoute(["proof", "show", "run-20260603-abc123"]);
    const b = await bashRoute(["proof", "show", "run-20260603-abc123"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    // Compare structurally: bash uses jq (if present) else python json.dumps,
    // Bun uses JSON.stringify. All emit 2-space-indented JSON of the same data,
    // but deep-equal is robust to any whitespace/key-order formatting drift.
    expect(JSON.parse(a.stdout)).toEqual(JSON.parse(b.stdout));
    expect(JSON.parse(a.stdout)).toEqual(FULL_PROOF);
  });

  it("missing id: both exit 1 with not-found message", async () => {
    seedProof("run-20260603-abc123", FULL_PROOF);
    const a = await bunRoute(["proof", "show", "does-not-exist"]);
    const b = await bashRoute(["proof", "show", "does-not-exist"]);
    expect(a.exitCode).toBe(1);
    expect(b.exitCode).toBe(1);
    expect(a.stderr + a.stdout).toContain("not found");
    expect(b.stderr + b.stdout).toContain("not found");
  });

  it("no id arg: both exit 2", async () => {
    const a = await bunRoute(["proof", "show"]);
    const b = await bashRoute(["proof", "show"]);
    expect(a.exitCode).toBe(2);
    expect(b.exitCode).toBe(2);
  });
});

// In-process Bun unit checks (fast, no spawn) for the str()/listProofs edge
// cases, mirroring the existing command-test style (rollback.test.ts).
describe("loki proof: Bun in-process edge cases", () => {
  let captured = { stdout: "", stderr: "" };
  let restore: () => void = () => {};

  function captureOutput(): void {
    captured = { stdout: "", stderr: "" };
    const oOut = process.stdout.write.bind(process.stdout);
    const oErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: unknown): boolean => {
      captured.stdout += String(c);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown): boolean => {
      captured.stderr += String(c);
      return true;
    }) as typeof process.stderr.write;
    restore = () => {
      process.stdout.write = oOut;
      process.stderr.write = oErr;
    };
  }

  beforeEach(() => {
    process.env["LOKI_DIR"] = scratch;
  });

  it("empty proofs dir prints no header", async () => {
    mkdirSync(join(scratch, "proofs"), { recursive: true });
    captureOutput();
    const code = await runProof(["list"]);
    restore();
    expect(code).toBe(0);
    expect(captured.stdout).toContain("No proofs found");
    expect(captured.stdout).not.toContain("RUN_ID");
  });

  it("null fields render '-' not 'None'", async () => {
    seedProof("run-20260603-null01", NULL_PROOF);
    captureOutput();
    const code = await runProof(["list"]);
    restore();
    expect(code).toBe(0);
    expect(captured.stdout).not.toContain("None");
    expect(captured.stdout).toContain("-");
  });

  it("help exits 0, no-arg exits 1", async () => {
    captureOutput();
    const help = await runProof(["help"]);
    const bare = await runProof([]);
    restore();
    expect(help).toBe(0);
    expect(bare).toBe(1);
  });
});
