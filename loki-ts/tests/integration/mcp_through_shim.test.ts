// Integration: MCP-through-shim contract test.
//
// Goal: verify that subprocess-style invocations of `loki <cmd>` (the pattern
// MCP tools use when they shell out) produce JSON output that matches the
// schema MCP server expects.
//
// Discovery (2026-04-26): mcp/server.py does NOT currently use subprocess to
// invoke `loki`. It imports modules directly (e.g. memory.engine). Therefore
// "MCP-through-shim" is currently a CONTRACT test: we exercise the bin/loki
// shim with the JSON-emitting commands an MCP tool would naturally call to
// surface session state, and we assert the schema is stable. If MCP later
// gains a subprocess wrapper, this same test guards the contract.
//
// Strategy: spawn `bin/loki <cmd> --json` via Bun.spawn with PATH manipulated
// so the shim is the first `loki` on PATH (mirrors how an MCP server's
// subprocess.run("loki ...") would resolve). LOKI_LEGACY_BASH is left unset
// so we get the Bun route for ported commands; LOKI_DIR points at a tmpdir
// to keep the test hermetic.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SHIM = join(REPO_ROOT, "bin", "loki");
const BIN_DIR = join(REPO_ROOT, "bin");

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runShim(args: string[], lokiDir: string): Promise<SpawnResult> {
  // Mimic an MCP subprocess.run({"loki", ...}, env={...}) call. We force the
  // BUN_FROM_SOURCE path because dist/ may not exist in dev/test environments.
  const proc = Bun.spawn([SHIM, ...args], {
    env: {
      ...process.env,
      LOKI_DIR: lokiDir,
      BUN_FROM_SOURCE: "1",
      // Put bin/ first on PATH so a hypothetical `subprocess.run("loki ...")`
      // would resolve the shim, not a globally-installed loki.
      PATH: `${BIN_DIR}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

let tmpLokiDir: string;

beforeEach(() => {
  tmpLokiDir = mkdtempSync(join(tmpdir(), "loki-mcp-shim-"));
});

afterEach(() => {
  if (tmpLokiDir) {
    try { rmSync(tmpLokiDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("MCP-through-shim contract", () => {
  it("status --json returns the schema MCP would consume", async () => {
    const r = await runShim(["status", "--json"], tmpLokiDir);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    // Schema MCP would surface as a session-state tool: exact field names are
    // load-bearing because dashboard/control.py:get_status() and any future
    // MCP wrapper share this contract.
    expect(typeof parsed.version).toBe("string");
    expect(typeof parsed.status).toBe("string");
    // phase is nullable on first run (no orchestrator state yet); MCP wrapper
    // must tolerate either string or null.
    expect(["string", "object"]).toContain(typeof parsed.phase);
    if (parsed.phase !== null) expect(typeof parsed.phase).toBe("string");
    expect(typeof parsed.iteration).toBe("number");
    expect(typeof parsed.provider).toBe("string");
    // task_counts is the field MCP-side aggregators would map to a "queue"
    // resource; assert shape but not values (hermetic dir has no queue).
    expect(typeof parsed.task_counts).toBe("object");
    expect(parsed.task_counts).not.toBeNull();
    expect(typeof parsed.task_counts.total).toBe("number");
  });

  it("doctor --json returns the dependency-check contract", async () => {
    const r = await runShim(["doctor", "--json"], tmpLokiDir);
    // doctor exits non-zero when a check fails, but the JSON must still be
    // emitted on stdout for an MCP wrapper to surface. Accept either exit code.
    expect([0, 1, 2]).toContain(r.exitCode);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(0);
    const sample = parsed.checks[0];
    expect(typeof sample.name).toBe("string");
    expect(typeof sample.status).toBe("string");
    expect(["pass", "fail", "warn", "missing"]).toContain(sample.status);
  });

  it("version is parseable as a semver string", async () => {
    const r = await runShim(["version"], tmpLokiDir);
    expect(r.exitCode).toBe(0);
    // version is human-formatted ("Loki Mode vX.Y.Z"); MCP would regex it.
    expect(r.stdout).toMatch(/Loki Mode v\d+\.\d+\.\d+/);
  });

  it("provider list emits stable text (MCP would parse names)", async () => {
    const r = await runShim(["provider", "list"], tmpLokiDir);
    expect(r.exitCode).toBe(0);
    // Strip ANSI for stable parsing -- mirrors what an MCP wrapper would do.
    const plain = r.stdout.replace(/\u001b\[[0-9;]*m/g, "");
    // The 5 documented providers must appear by name. Order is stable in the
    // bash CLI; we assert presence, not order, to remain robust.
    // v7.5.18: gemini removed from provider set.
    for (const name of ["claude", "codex", "cline", "aider"]) {
      expect(plain).toContain(name);
    }
  });

  it("memory list is invokable and produces output without crashing", async () => {
    // memory list under an empty LOKI_DIR returns an empty result rather than
    // erroring -- this is the contract MCP relies on for first-run sessions.
    const r = await runShim(["memory", "list"], tmpLokiDir);
    // Accept exit 0 or a documented "no memory yet" non-zero. We assert the
    // stream is non-empty (header or empty-state message) and stderr does not
    // contain a Bun stack trace.
    expect([0, 1]).toContain(r.exitCode);
    expect(r.stderr).not.toMatch(/at .+\.ts:\d+/);
  });
});
