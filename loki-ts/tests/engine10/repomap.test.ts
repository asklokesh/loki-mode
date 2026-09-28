// loki-ts/tests/engine10/repomap.test.ts
//
// E-98d: buildRepoMap only matched JS `export` names, so every Python repo
// got 0 symbols. Covers the added Python def/class regex plus a JS
// regression check so the existing behavior stays intact.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("nested or indented defs are not extracted", () => {
  writeFileSync(
    join(dir, "app.py"),
    "class Outer:\n    def method(self):\n        def inner():\n            pass\n        return inner\n",
  );
  commitAll();
  const map = buildRepoMap(dir);
  const entry = map.entries.find((e) => e.path === "app.py");
  expect(entry?.symbols).toEqual(["Outer"]);
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
