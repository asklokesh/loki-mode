// loki-ts/tests/engine10/repomap.test.ts
//
// E-98d: buildRepoMap only matched JS `export` names, so every Python repo
// got 0 symbols. Covers the added Python def/class regex plus a JS
// regression check so the existing behavior stays intact.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepoMap } from "../../src/engine10/repomap.ts";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e10-repomap-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function commitAll(): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
}

test("python fixture yields top-level def and class names", () => {
  writeFileSync(
    join(dir, "app.py"),
    "def handler(event):\n    pass\n\n\nclass Widget:\n    pass\n",
  );
  commitAll();
  const map = buildRepoMap(dir);
  const entry = map.entries.find((e) => e.path === "app.py");
  expect(entry?.symbols).toEqual(["handler", "Widget"]);
});

test("nested defs inside a method are not extracted, the method is", () => {
  writeFileSync(
    join(dir, "app.py"),
    "class Outer:\n    def method(self):\n        def inner():\n            pass\n        return inner\n",
  );
  commitAll();
  const map = buildRepoMap(dir);
  const entry = map.entries.find((e) => e.path === "app.py");
  expect(entry?.symbols).toEqual(["Outer", "Outer.method"]);
});

test("top-level async def is captured, indented async def is not", () => {
  writeFileSync(
    join(dir, "app.py"),
    "async def handler(event):\n    async def inner():\n        pass\n    return inner\n",
  );
  commitAll();
  const map = buildRepoMap(dir);
  const entry = map.entries.find((e) => e.path === "app.py");
  expect(entry?.symbols).toEqual(["handler"]);
});

test("JS export behavior is unchanged", () => {
  writeFileSync(
    join(dir, "widget.ts"),
    "export function makeWidget() {}\nexport class Widget {}\n",
  );
  commitAll();
  const map = buildRepoMap(dir);
  const entry = map.entries.find((e) => e.path === "widget.ts");
  expect(entry?.symbols).toEqual(["makeWidget", "Widget"]);
});

test("python method past byte 20000 is indexed as Class.method", () => {
  const filler = "# pad\n".repeat(10_000);
  writeFileSync(
    join(dir, "models.py"),
    `${filler}class QuerySet:\n    def bulk_create(self, objs):\n        pass\n\n    async def aget(self):\n        pass\n\ndef helper():\n    pass\n`,
  );
  commitAll();
  const symbols = buildRepoMap(dir).entries.find((e) => e.path === "models.py")?.symbols;
  expect(symbols).toEqual(["QuerySet", "QuerySet.bulk_create", "QuerySet.aget", "helper"]);
});

test("symbols are capped at 300 per file", () => {
  let src = "";
  for (let i = 0; i < 1000; i++) src += `def f${i}():\n    pass\n`;
  writeFileSync(join(dir, "many.py"), src);
  commitAll();
  expect(buildRepoMap(dir).entries.find((e) => e.path === "many.py")?.symbols.length).toBe(300);
});

function seedBigRepo(): void {
  mkdirSync(join(dir, "build"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  for (let i = 0; i < 15; i++) writeFileSync(join(dir, "build", `v${i}.js`), `export const v${i} = 1;\n`);
  for (let i = 0; i < 10; i++) writeFileSync(join(dir, "src", `s${i}.js`), `export const s${i} = 1;\n`);
  commitAll();
}

describe("file cap", () => {
  const saved = process.env.LOKI_E10_REPOMAP_MAX_FILES;
  afterEach(() => {
    if (saved === undefined) delete process.env.LOKI_E10_REPOMAP_MAX_FILES;
    else process.env.LOKI_E10_REPOMAP_MAX_FILES = saved;
  });

  test("env knob caps files and build dir is dropped before source", () => {
    seedBigRepo();
    process.env.LOKI_E10_REPOMAP_MAX_FILES = "12";
    const map = buildRepoMap(dir);
    expect(map.files.length).toBe(12);
    expect(map.truncated).toBe(true);
    expect(map.files.filter((f) => f.startsWith("src/")).length).toBe(10);
    expect(map.files.filter((f) => f.startsWith("build/")).length).toBe(2);
  });

  test("invalid knob falls back to default 2000, no reorder under cap", () => {
    seedBigRepo();
    process.env.LOKI_E10_REPOMAP_MAX_FILES = "abc";
    const map = buildRepoMap(dir);
    expect(map.truncated).toBe(false);
    expect(map.files.length).toBe(25);
    expect(map.files[0]).toBe("build/v0.js");
  });

  test("bad max files note", () => {
    seedBigRepo();
    for (const bad of ["abc", "0", "-5", "1.5"]) {
      process.env.LOKI_E10_REPOMAP_MAX_FILES = bad;
      const orig = process.stderr.write.bind(process.stderr);
      const seen: string[] = [];
      process.stderr.write = ((c: string | Uint8Array) => { seen.push(String(c)); return true; }) as typeof process.stderr.write;
      let map;
      try { map = buildRepoMap(dir); } finally { process.stderr.write = orig; }
      const notes = seen.filter((l) => l.includes("LOKI_E10_REPOMAP_MAX_FILES"));
      expect(notes.length).toBe(1);
      expect(notes[0]).toContain(JSON.stringify(bad));
      expect(notes[0]).toContain("2000");
      expect(map.files.length).toBe(25);
    }
  });

  test("filename containing a junk dir name is not junk", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "vendorish.js"), "export const a = 1;\n");
    mkdirSync(join(dir, "build"), { recursive: true });
    writeFileSync(join(dir, "build", "x.js"), "export const x = 1;\n");
    commitAll();
    process.env.LOKI_E10_REPOMAP_MAX_FILES = "1";
    expect(buildRepoMap(dir).files).toEqual(["src/vendorish.js"]);
  });
});
