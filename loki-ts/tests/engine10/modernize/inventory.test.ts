// M-02: Inventory core (files, languages, build system, entry points, tests).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInventory } from "../../../src/engine10/modernize/inventory.ts";

const FIX = join(import.meta.dir, "fixtures", "inv");

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** Copies the checked-in sample repo and git-initializes it in a temp dir, so
 *  git ls-files (repomap.ts) sees a real tracked tree without mutating the fixture. */
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "e10-mod-inv-"));
  cpSync(join(FIX, "sample-repo"), dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

let repoDir = "";
beforeEach(() => { repoDir = freshRepo(); });
afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

describe("buildInventory", () => {
  it("counts files by detected language", () => {
    const inv = buildInventory(repoDir);
    expect(inv.languages.python).toBe(3); // pkg/util.py, pkg/main.py, test_util.py
    expect(inv.languages.java).toBe(1);
    expect(inv.truncated).toBe(false);
    expect(inv.files.length).toBe(5);
  });

  it("detects the build system from the first matching marker", () => {
    const inv = buildInventory(repoDir);
    expect(inv.buildSystem).toEqual({ system: "poetry", marker: "pyproject.toml" });
  });

  it("reports no build system when no marker is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "e10-mod-inv-nomarker-"));
    try {
      git(dir, ["init", "-q"]);
      const inv = buildInventory(dir);
      expect(inv.buildSystem).toEqual({ system: null, marker: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds python and java entry points by their __main__/main() markers", () => {
    const inv = buildInventory(repoDir);
    expect(inv.entryPoints.sort()).toEqual(["App.java", "pkg/main.py"]);
  });

  it("reuses testmap.ts's runner detection for tests", () => {
    const inv = buildInventory(repoDir);
    expect(inv.tests.runners).toContain("pytest");
    expect(inv.tests.tests.some((t) => t.path === "test_util.py")).toBe(true);
  });
});
