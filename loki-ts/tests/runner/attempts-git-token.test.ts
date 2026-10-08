// FC-25: attempt git calls are token-free; only the push opts into the credential env. No network: git is a PATH shim.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../src/runner/attempts.ts";

let dir = "";
let log = "";
const saved = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-attempts-git-token-"));
  log = join(dir, "calls.log");
  writeFileSync(join(dir, "git"), `#!/bin/sh\nprintf '%s|%s\\n' "\${GH_TOKEN:-none}" "$*" >> '${log}'\n`);
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
  it("push keeps the token and credential helper; every other call is token-free", () => {
    git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["push", "-u", "origin", "b"], undefined, true);
    const calls = readFileSync(log, "utf8").trim().split("\n").filter((l) => !l.includes("config --includes"));
    const rev = calls.find((l) => l.includes("rev-parse"))!;
    const push = calls.find((l) => l.includes("push -u origin b"))!;
    expect(rev.startsWith("none|")).toBe(true);
    expect(rev).toContain("credential.helper=");
    expect(push.startsWith("tok-secret|")).toBe(true);
    expect(push).not.toContain("credential.helper=");
  });
});
