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

describe("memory flag hint", () => {
  it("suggests the closest allowed flag, and stays silent when none is close", async () => {
    const env = { ...process.env, LOKI_NO_BROWSER: "1" };
    for (const [args, hint] of [
      [["memory", "lessons", "--jsno"], "Did you mean '--json'?"],
      [["memory", "list", "--jsn"], "Did you mean '--json'?"],
      [["memory", "brief", "--taks", "x"], "Did you mean '--task'?"],
    ] as const) {
      const r = await run(["bun", CLI, ...args], { env });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain(hint);
    }
    const far = await run(["bun", CLI, "memory", "lessons", "--zzzzzzzz"], { env });
    expect(far.exitCode).toBe(2);
    expect(far.stderr).not.toContain("Did you mean");
  });
});

describe("memory search", () => {
  async function fixture(n: number, hits: number[]) {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(resolve(tmpdir(), "loki-msearch-"));
    for (let i = 0; i < n; i++) {
      const rd = resolve(d, ".loki", "runs", `run-${String(i).padStart(4, "0")}`);
      mkdirSync(rd, { recursive: true });
      writeFileSync(resolve(rd, "receipt.json"), `{\n  "verdict": "VERIFIED",\n  "note": "${hits.includes(i) ? "Flaky LockFile retry" : "plain"}"\n}\n`);
    }
    return d;
  }
  const env = { ...process.env, LOKI_NO_BROWSER: "1" };

  it("20-run fixture returns exactly the 3 matching runs with id, date, file and line", async () => {
    const { rmSync } = await import("node:fs");
    const d = await fixture(20, [2, 7, 13]);
    try {
      const r = await run(["bun", CLI, "memory", "search", "lockfile", "--json"], { cwd: d, env });
      expect(r.exitCode).toBe(0);
      const hits = JSON.parse(r.stdout);
      expect(hits.map((h: { run_id: string }) => h.run_id).sort()).toEqual(["run-0002", "run-0007", "run-0013"]);
      for (const h of hits) {
        expect(h.line).toBe(3);
        expect(h.file).toBe(`.loki/runs/${h.run_id}/receipt.json`);
        expect(h.date).toMatch(/^\d{4}-\d{2}-\d{2}/);
        expect(h.text).toContain("LockFile");
      }
      const t = await run(["bun", CLI, "memory", "search", "lockfile"], { cwd: d, env });
      expect(t.exitCode).toBe(0);
      expect(t.stdout).toContain("run-0007");
      expect(t.stdout).toContain(":3:");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("searches decisions and lessons too", async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const d = await fixture(1, []);
    try {
      mkdirSync(resolve(d, ".loki", "memory", "semantic"), { recursive: true });
      writeFileSync(resolve(d, ".loki", "memory", "semantic", "pr-lessons.json"), `{\n "lessons": [{"text": "use flock"}]\n}\n`);
      mkdirSync(resolve(d, ".loki", "decisions"), { recursive: true });
      writeFileSync(resolve(d, ".loki", "decisions", "d1.md"), "# D1\nchose FLOCK over mkdir\n");
      const r = await run(["bun", CLI, "memory", "search", "flock", "--json"], { cwd: d, env });
      const hits = JSON.parse(r.stdout);
      expect(hits.map((h: { file: string; line: number }) => `${h.file}:${h.line}`).sort()).toEqual([".loki/decisions/d1.md:2", ".loki/memory/semantic/pr-lessons.json:2"]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("missing dirs give no hits and exit 0; empty or bad input is a usage error", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const d = mkdtempSync(resolve(tmpdir(), "loki-msearch-"));
    try {
      const r = await run(["bun", CLI, "memory", "search", "x", "--json"], { cwd: d, env });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([]);
      for (const args of [["memory", "search"], ["memory", "search", "  "], ["memory", "search", "--json"], ["memory", "search", "x", "--bogus"]]) {
        const e = await run(["bun", CLI, ...args], { cwd: d, env });
        expect(e.exitCode).toBe(2);
        expect(e.stderr).toContain("Usage: loki memory search <text> [--json]");
        expect(e.stdout).toBe("");
      }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("1000-run fixture finishes well under 1s", async () => {
    const { rmSync } = await import("node:fs");
    const { searchMemory } = await import("../../src/commands/memory.ts");
    const d = await fixture(1000, [5, 500, 999]);
    try {
      const t0 = performance.now();
      const hits = searchMemory(d, "lockfile");
      const ms = performance.now() - t0;
      expect(hits.length).toBe(3);
      expect(ms).toBeLessThan(1000);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("does not follow symlinked files or directories out of .loki", async () => {
    const { mkdirSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
    const { searchMemory } = await import("../../src/commands/memory.ts");
    const d = await fixture(1, []);
    const outside = resolve(d, "..", `${d.split("/").pop()}-outside`);
    try {
      mkdirSync(resolve(outside, "dir"), { recursive: true });
      writeFileSync(resolve(outside, "x.txt"), "needle outside file\n");
      writeFileSync(resolve(outside, "dir", "y.txt"), "needle outside dir\n");
      symlinkSync(resolve(outside, "x.txt"), resolve(d, ".loki", "runs", "run-0000", "link.txt"));
      symlinkSync(resolve(outside, "dir"), resolve(d, ".loki", "runs", "run-0001"));
      symlinkSync(resolve(outside, "x.txt"), resolve(d, ".loki", "runs", "loose.txt"));
      mkdirSync(resolve(d, ".loki", "decisions"), { recursive: true });
      symlinkSync(resolve(outside, "x.txt"), resolve(d, ".loki", "decisions", "d.md"));
      expect(searchMemory(d, "needle")).toEqual([]);
      const r = await run(["bun", CLI, "memory", "search", "needle"], { cwd: d, env });
      expect(r.stdout).not.toContain("outside");
    } finally { rmSync(d, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  it("withholds every line of a multi-line PEM private key in text and json output", async () => {
    const { writeFileSync, rmSync } = await import("node:fs");
    const d = await fixture(1, []);
    try {
      const body = ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "KgwggSmAgEAAoIBAQC7VJTUt9Us8cKj", "bodysecretlinethree0987654321", "QwErTyUiOpAsDfGhJkLzXcVbNm123456"];
      writeFileSync(resolve(d, ".loki", "runs", "run-0000", "key.txt"), ["before", "-----BEGIN PRIVATE KEY-----", ...body, "-----END PRIVATE KEY-----", "after"].join("\n") + "\n");
      for (const needle of ["bodysecretline", "KgwggSmAgEAAoIB", "QwErTy"]) {
        const j = await run(["bun", CLI, "memory", "search", needle, "--json"], { cwd: d, env });
        const t = await run(["bun", CLI, "memory", "search", needle], { cwd: d, env });
        for (const out of [j.stdout, t.stdout]) for (const b of body) expect(out).not.toContain(b);
        expect(JSON.parse(j.stdout)).toEqual([]);
      }
      const a = await run(["bun", CLI, "memory", "search", "after", "--json"], { cwd: d, env });
      expect(JSON.parse(a.stdout).length).toBe(1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("refuses a hardlink under .loki to a file outside it", async () => {
    const { mkdirSync, writeFileSync, linkSync, rmSync } = await import("node:fs");
    const { searchMemory } = await import("../../src/commands/memory.ts");
    const d = await fixture(1, []);
    const outside = resolve(d, "..", `${d.split("/").pop()}-hl`);
    try {
      mkdirSync(outside, { recursive: true });
      writeFileSync(resolve(outside, "x.txt"), "needle hardlinked\n");
      linkSync(resolve(outside, "x.txt"), resolve(d, ".loki", "runs", "run-0000", "hard.txt"));
      expect(searchMemory(d, "needle")).toEqual([]);
      const r = await run(["bun", CLI, "memory", "search", "needle", "--json"], { cwd: d, env });
      expect(JSON.parse(r.stdout)).toEqual([]);
    } finally { rmSync(d, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  it("does not follow a symlinked parent dir (.loki/memory) or a symlinked .loki", async () => {
    const { mkdirSync, writeFileSync, symlinkSync, rmSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { searchMemory } = await import("../../src/commands/memory.ts");
    const out = mkdtempSync(resolve(tmpdir(), "loki-msearch-out-"));
    const p1 = mkdtempSync(resolve(tmpdir(), "loki-msearch-"));
    const p2 = mkdtempSync(resolve(tmpdir(), "loki-msearch-"));
    try {
      mkdirSync(resolve(out, "semantic"), { recursive: true });
      writeFileSync(resolve(out, "semantic", "g.txt"), "needle one\n");
      mkdirSync(resolve(p1, ".loki"), { recursive: true });
      symlinkSync(out, resolve(p1, ".loki", "memory"));
      expect(searchMemory(p1, "needle")).toEqual([]);
      mkdirSync(resolve(out, "real", "decisions"), { recursive: true });
      writeFileSync(resolve(out, "real", "decisions", "d.txt"), "needle two\n");
      symlinkSync(resolve(out, "real"), resolve(p2, ".loki"));
      expect(searchMemory(p2, "needle")).toEqual([]);
    } finally { for (const x of [out, p1, p2]) rmSync(x, { recursive: true, force: true }); }
  });

  it("handles a single huge line with bounded memory and line length", async () => {
    const { writeFileSync, rmSync, appendFileSync } = await import("node:fs");
    const { eachLine, searchMemory } = await import("../../src/commands/memory.ts");
    const d = await fixture(1, []);
    const big = resolve(d, ".loki", "runs", "run-0000", "big.txt");
    try {
      writeFileSync(big, "");
      const chunk = "a".repeat(1024 * 1024);
      for (let i = 0; i < 64; i++) appendFileSync(big, chunk);
      appendFileSync(big, "\nneedle tail\n");
      let longest = 0;
      const before = process.memoryUsage().rss;
      eachLine(big, (l) => { longest = Math.max(longest, l.length); });
      const growth = process.memoryUsage().rss - before;
      expect(longest).toBeLessThanOrEqual(1024 * 1024);
      expect(growth).toBeLessThan(48 * 1024 * 1024);
      expect(searchMemory(d, "needle").map((h) => h.line)).toEqual([2]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("redacts secrets in text and json output", async () => {
    const { writeFileSync, rmSync } = await import("node:fs");
    const d = await fixture(1, []);
    const gh = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const ant = "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz0123456789";
    try {
      writeFileSync(resolve(d, ".loki", "runs", "run-0000", "events.jsonl"), `{"msg":"leak token ${gh} and ${ant}"}\n`);
      const j = await run(["bun", CLI, "memory", "search", "leak", "--json"], { cwd: d, env });
      const t = await run(["bun", CLI, "memory", "search", "leak"], { cwd: d, env });
      for (const out of [j.stdout, t.stdout]) {
        expect(out).toContain("leak token");
        expect(out).not.toContain(gh);
        expect(out).not.toContain(ant);
        expect(out).not.toContain("ghp_a1B2");
        expect(out).not.toContain("sk-ant-api03");
      }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("matches an uppercase query case-insensitively", async () => {
    const { rmSync } = await import("node:fs");
    const { searchMemory } = await import("../../src/commands/memory.ts");
    const d = await fixture(2, [1]);
    try {
      expect(searchMemory(d, "LOCKFILE").length).toBe(1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it("skips binary (NUL) files and reads large files line by line", async () => {
    const { writeFileSync, rmSync } = await import("node:fs");
    const { searchMemory } = await import("../../src/commands/memory.ts");
    const d = await fixture(1, []);
    try {
      writeFileSync(resolve(d, ".loki", "runs", "run-0000", "bin.dat"), "needle\0binary\n");
      writeFileSync(resolve(d, ".loki", "runs", "run-0000", "big.log"), "x\n".repeat(1100 * 1024) + "needle at end\n");
      const hits = searchMemory(d, "needle");
      expect(hits.map((h) => h.file)).toEqual([".loki/runs/run-0000/big.log"]);
      expect(hits[0]?.line).toBe(1100 * 1024 + 1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
