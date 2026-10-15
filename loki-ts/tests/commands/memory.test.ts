import { describe, expect, it } from "bun:test";
import { run } from "../../src/util/shell.ts";
import { stripAnsi } from "../../src/util/colors.ts";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const CLI = resolve(REPO_ROOT, "loki-ts", "src", "cli.ts");
const BASH_CLI = resolve(REPO_ROOT, "autonomy", "loki");

async function bunCmd(args: string[]) {
  return run(["bun", CLI, ...args]);
}

async function bashCmd(args: string[]) {
  return run([BASH_CLI, ...args]);
}

describe("memory list", () => {
  it("byte-for-byte parity with bash", async () => {
    const a = await bunCmd(["memory", "list"]);
    const b = await bashCmd(["memory", "list"]);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it("ls alias produces same output", async () => {
    const a = await bunCmd(["memory", "list"]);
    const c = await bunCmd(["memory", "ls"]);
    expect(a.stdout).toBe(c.stdout);
  });

  it("displays counts for all three categories", async () => {
    const a = await bunCmd(["memory", "list"]);
    const plain = stripAnsi(a.stdout);
    expect(plain).toContain("Patterns:");
    expect(plain).toContain("Mistakes:");
    expect(plain).toContain("Successes:");
  });
});

describe("memory index (display)", () => {
  it("displays index.json when present, else 'No index found'", async () => {
    const a = await bunCmd(["memory", "index"]);
    expect(a.exitCode).toBe(0);
    // Either valid JSON output or the fallback string -- both are valid.
    const out = stripAnsi(a.stdout);
    if (!out.includes("No index found")) {
      // If we got JSON, it should parse.
      expect(() => JSON.parse(out)).not.toThrow();
    }
  });
});

describe("memory brief (INJECT)", () => {
  it("prints the fenced learnings block; empty repo prints nothing", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(resolve(tmpdir(), "loki-brief-"));
    const env = { ...process.env, LOKI_NO_BROWSER: "1" };
    try {
      const empty = await run(["bun", CLI, "memory", "brief", "--task", "x"], { cwd: d, env });
      expect(empty.exitCode).toBe(0);
      expect(empty.stdout).toBe("");
      mkdirSync(resolve(d, ".loki", "state"), { recursive: true });
      writeFileSync(resolve(d, ".loki", "state", "relevant-learnings.json"), JSON.stringify({ version: 1, learnings: [{ id: "abc", timestamp: "t", iteration: 1, trigger: "gate_failure", rootCause: "flaky lock", fix: "f", preventInFuture: "use flock", evidence: {} }] }));
      const r = await run(["bun", CLI, "memory", "brief", "--task", "x"], { cwd: d, env });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("<untrusted-learnings>");
      expect(r.stdout).toContain("confidence 0.50");
      expect(r.stdout).toContain("use flock");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
