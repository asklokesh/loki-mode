import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/util/shell.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const CLI = resolve(REPO_ROOT, "loki-ts", "src", "cli.ts");
const BASH_CLI = resolve(REPO_ROOT, "autonomy", "loki");

let root = "";

function makeFixture(name: string): string {
  const dir = join(root, name);
  const day = join(dir, ".loki", "memory", "episodic", "2026-01-01");
  mkdirSync(day, { recursive: true });
  for (const id of ["ep-1", "ep-2"]) {
    writeFileSync(
      join(day, `${id}.json`),
      JSON.stringify({ id, timestamp: "2026-01-01T00:00:00Z", context: { goal: `goal ${id}`, phase: "dev" } }),
    );
  }
  return dir;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

const ENV = { LOKI_NO_BROWSER: "1" };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "loki-memidx-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("memory index rebuild (Bun route)", () => {
  it("indexes the episodes and leaves them unchanged", async () => {
    const dir = makeFixture("bun");
    const epFile = join(dir, ".loki/memory/episodic/2026-01-01/ep-1.json");
    const before = readFileSync(epFile, "utf-8");
    const r = await run(["bun", CLI, "memory", "index", "rebuild"], { cwd: dir, env: ENV });
    expect(r.exitCode).toBe(0);
    const idx = readJson(join(dir, ".loki/memory/index.json"));
    expect(idx.total_memories).toBe(2);
    expect(idx.topics.length).toBe(1);
    expect(readFileSync(epFile, "utf-8")).toBe(before);
  });

  it("prints the error and returns non-zero when python fails", async () => {
    const dir = join(root, "fail");
    // A regular file where the memory directory belongs makes the engine raise.
    mkdirSync(join(dir, ".loki"), { recursive: true });
    writeFileSync(join(dir, ".loki", "memory"), "not a directory");
    const r = await run(["bun", CLI, "memory", "index", "rebuild"], { cwd: dir, env: ENV });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain("Index rebuilt");
    expect(r.stdout + r.stderr).toContain("index rebuild failed");
  });

  it("produces the same index.json as the bash route", async () => {
    const a = makeFixture("parity-bun");
    const b = makeFixture("parity-bash");
    const ra = await run(["bun", CLI, "memory", "index", "rebuild"], { cwd: a, env: ENV });
    const rb = await run([BASH_CLI, "memory", "index", "rebuild"], { cwd: b, env: { ...ENV, LOKI_LEGACY_BASH: "1" } });
    expect(ra.exitCode).toBe(0);
    expect(rb.exitCode).toBe(0);
    const ia = readJson(join(a, ".loki/memory/index.json"));
    const ib = readJson(join(b, ".loki/memory/index.json"));
    delete ia.last_updated;
    delete ib.last_updated;
    expect(ia).toEqual(ib);
    expect(ra.stdout).toBe(rb.stdout);
  });
});
