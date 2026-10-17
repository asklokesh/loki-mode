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

describe("memory list json", () => {
  it("list json prints counts and learnings path, text output unchanged", async () => {
    const a = await bunCmd(["memory", "list", "--json"]);
    expect(a.exitCode).toBe(0);
    const j = JSON.parse(a.stdout);
    expect(typeof j.patterns).toBe("number");
    expect(typeof j.mistakes).toBe("number");
    expect(typeof j.successes).toBe("number");
    expect(j.learnings_path).toContain("learnings");
    const t = await bunCmd(["memory", "list"]);
    expect(stripAnsi(t.stdout)).toContain("Patterns:");
    expect(() => JSON.parse(t.stdout)).toThrow();
  });

  it("list json via bin/loki entry path", async () => {
    const a = await run([resolve(REPO_ROOT, "bin", "loki"), "memory", "ls", "--json"]);
    expect(a.exitCode).toBe(0);
    expect(Object.keys(JSON.parse(a.stdout))).toEqual(["patterns", "mistakes", "successes", "learnings_path"]);
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

  it("brief without task value prints usage and exits 2", async () => {
    for (const args of [["memory", "brief", "--task"], ["memory", "brief", "--task", ""], ["memory", "brief", "--task", "--json"]]) {
      const r = await run(["bun", CLI, ...args], { env: { ...process.env, LOKI_NO_BROWSER: "1" } });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("Usage: loki memory brief [--task <text>]");
      expect(r.stdout).toBe("");
    }
  });
});

describe("memory unknown flag", () => {
  it("lessons/list/brief reject unknown flags with usage and exit 2; known flags still work", async () => {
    const env = { ...process.env, LOKI_NO_BROWSER: "1" };
    for (const [args, usage] of [
      [["memory", "lessons", "--jsno"], "Usage: loki memory lessons [--json]"],
      [["memory", "list", "--bogus"], "Usage: loki memory list [--json]"],
      [["memory", "brief", "--bogus"], "Usage: loki memory brief [--task <text>]"],
    ] as const) {
      const r = await run(["bun", CLI, ...args], { env });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("unknown flag");
      expect(r.stderr).toContain(usage);
      expect(r.stdout).toBe("");
    }
    for (const args of [["memory", "lessons", "--json"], ["memory", "list", "--json"], ["memory", "brief", "--task", "x"]]) {
      const r = await run(["bun", CLI, ...args], { env });
      expect(r.exitCode).toBe(0);
    }
  });
});
