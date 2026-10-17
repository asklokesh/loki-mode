import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runUndo, type GitRunner } from "../../src/commands/undo.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "undo-list-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date("2026-10-17T10:00:00.000Z");
const BASE = "a".repeat(40), HEAD = "b".repeat(40);

function mkRun(id: string, ageSec: number, body: string = JSON.stringify({ schema: "loki.v10.receipt/1", base_sha: BASE, head_sha: HEAD })): void {
  mkdirSync(join(dir, id), { recursive: true });
  const p = join(dir, id, "receipt.json");
  writeFileSync(p, body);
  const t = new Date(NOW.getTime() - ageSec * 1000);
  utimesSync(p, t, t);
}

async function list(args: string[] = ["--list"], git?: GitRunner) {
  const out: string[] = [], err: string[] = [], calls: string[][] = [];
  const g: GitRunner = git ?? ((_d, a) => { calls.push([...a]); return { status: 0, stdout: "x.ts\ny.ts\nx.ts\n" }; });
  const rc = await runUndo(args, { runsRoot: dir, repoDir: dir, now: () => NOW, git: g, out: (s) => void out.push(s), err: (s) => void err.push(s) });
  return { rc, out: out.join(""), err: err.join(""), calls };
}

describe("loki undo --list", () => {
  test("empty runs dir says no runs to undo", async () => {
    const r = await list();
    expect(r.rc).toBe(0);
    expect(r.out).toBe("no runs to undo\n");
  });

  test("missing runs dir says no runs to undo", async () => {
    rmSync(dir, { recursive: true, force: true });
    const r = await list();
    expect(r.rc).toBe(0);
    expect(r.out).toBe("no runs to undo\n");
  });

  test("lists newest first with verdict, unique file count and age", async () => {
    mkRun("old-run", 7200);
    mkRun("new-run", 120);
    const r = await list();
    expect(r.rc).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines[0]).toMatch(/^RUN\s+VERDICT\s+FILES\s+AGE$/);
    expect(lines[1]).toMatch(/^new-run\s+\S+\s+2\s+2m$/);
    expect(lines[2]).toMatch(/^old-run\s+\S+\s+2\s+2h$/);
    expect(r.calls.every((c) => c[0] === "log")).toBe(true);
  });

  test("receipt without hex refs shows - for files and still lists", async () => {
    mkRun("odd", 30, JSON.stringify({ schema: "loki.v10.receipt/1" }));
    const r = await list();
    expect(r.rc).toBe(0);
    expect(r.out.trim().split("\n")[1]).toMatch(/^odd\s+\S+\s+-\s+30s$/);
  });

  test("dirs without a receipt are skipped", async () => {
    mkdirSync(join(dir, "empty-run"));
    mkRun("real", 10);
    const r = await list();
    expect(r.out).not.toContain("empty-run");
    expect(r.out).toContain("real");
  });

  test("caps at 20 rows", async () => {
    for (let i = 0; i < 25; i++) mkRun(`r${String(i).padStart(2, "0")}`, 100 + i);
    const r = await list();
    expect(r.out.trim().split("\n").length).toBe(21);
  });

  test("--list with another argument is a usage error", async () => {
    const r = await list(["--list", "x"]);
    expect(r.rc).toBe(2);
    expect(r.err).toContain("--list takes no other arguments");
  });
});

describe("loki undo unknown flag", () => {
  for (const args of [["run1", "--bogus"], ["run1", "--dry-rn"], ["run1", "--plan", "-x"], ["--list", "--bogus"], ["--bogus"]]) {
    test(`unknown flag rejected: ${args.join(" ")}`, async () => {
      const r = await list(args);
      expect(r.rc).toBe(2);
      const bad = args.find((a) => a === "--bogus" || a === "--dry-rn" || a === "-x")!;
      expect(r.err).toBe(`loki undo: unknown flag ${bad} (see loki undo --help)\n`);
      expect(r.calls.length).toBe(0);
    });
  }
  test("valid flags still accepted", async () => {
    expect((await list(["run1", "--plan", "--help"])).rc).toBe(0);
    expect((await list(["--list"])).rc).toBe(0);
  });
});
