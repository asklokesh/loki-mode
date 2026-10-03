// P1-DISCARD-PROTO: prototype-named paths must not be mistaken for pre-existing dirt by discardIfSatisfied.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardIfSatisfied } from "../../src/e10ext/discard.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sh = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });

describe("discardIfSatisfied prototype-named paths", () => {
  test("new constructor, edited toString and edited src.ts all return to base", async () => {
    const repo = mkdtempSync(join(tmpdir(), "discard-proto-")); dirs.push(repo);
    sh(repo, ["init", "-q"]); sh(repo, ["config", "user.email", "t@t"]); sh(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "toString"), "base\n"); writeFileSync(join(repo, "src.ts"), "base\n");
    sh(repo, ["add", "toString", "src.ts"]); sh(repo, ["commit", "-q", "-m", "base"]);
    const base = sh(repo, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "constructor"), "new\n"); writeFileSync(join(repo, "toString"), "edited\n"); writeFileSync(join(repo, "src.ts"), "edited\n");
    sh(repo, ["add", "constructor", "toString", "src.ts"]);
    const git = async (args: string[]) => { try { return { out: sh(repo, args), code: 0 }; } catch { return { out: "", code: 1 }; } };
    const staged = [{ st: "A", f: "constructor" }, { st: "M", f: "toString" }, { st: "M", f: "src.ts" }];
    const r = await discardIfSatisfied(git, base, { intake: { already_satisfied: true } }, staged, new Set(), repo);
    expect(r?.status).toBe("completed");
    expect((r?.data as { discarded: number }).discarded).toBe(3);
    expect(existsSync(join(repo, "constructor"))).toBe(false);
    expect(readFileSync(join(repo, "toString"), "utf8")).toBe("base\n");
    expect(readFileSync(join(repo, "src.ts"), "utf8")).toBe("base\n");
    expect(sh(repo, ["status", "--porcelain"])).toBe("");
  }, 30000);
});
