// FC-25: attempt git calls are token-free; only the push opts into the credential env. No network: git is a PATH shim.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionDeps } from "../../src/runner/attempts.ts";

let dir = "";
let log = "";
const saved = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-attempts-git-token-"));
  log = join(dir, "calls.log");
  writeFileSync(join(dir, "git"), `#!/bin/sh\nprintf '%s|%s\\n' "\${GH_TOKEN:-none}" "$*" >> '${log}'\ncase "$*" in *symbolic-ref*) echo mybranch;; *"config --get"*) echo https://github.com/acme/widgets.git;; esac\n`);
  writeFileSync(join(dir, "gh"), `#!/bin/sh\nprintf '%s|gh %s\\n' "\${GH_TOKEN:-none}" "$*" >> '${log}'\necho https://example.invalid/pr/1\n`);
  chmodSync(join(dir, "gh"), 0o755);
  chmodSync(join(dir, "git"), 0o755);
  process.env.PATH = `${dir}:${saved.PATH}`;
  process.env.GH_TOKEN = "tok-secret";
});
afterAll(() => {
  process.env.PATH = saved.PATH;
  if (saved.GH_TOKEN === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved.GH_TOKEN;
  rmSync(dir, { recursive: true, force: true });
});

describe("attempt git credential scope", () => {
  it("openPr: only the winner push keeps the token; every other git call is token-free", () => {
    const deps = productionDeps(dir, async () => 0, async () => 0, { noPr: false });
    expect(deps.openPr!(dir, "base")).toBe("https://example.invalid/pr/1");
    const calls = readFileSync(log, "utf8").trim().split("\n").filter((l) => !l.includes("config --includes"));
    const pushes = calls.filter((l) => l.includes(" push -- https://github.com/acme/widgets.git mybranch"));
    expect(pushes.length).toBe(1);
    expect(pushes[0]!.startsWith("tok-secret|")).toBe(true);
    expect(pushes[0]).not.toContain("credential.helper=");
    const others = calls.filter((l) => !l.includes(" push ") && !l.includes("|gh "));
    expect(others.length).toBeGreaterThan(0);
    for (const l of others) {
      expect(l.startsWith("none|")).toBe(true);
      expect(l).toContain("credential.helper=");
    }
  });
});
