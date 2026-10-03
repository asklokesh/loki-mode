// Automatic completion install: temp HOME and fake fpath only, never the real home.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoInstall, completeKind } from "../../src/cli/completions.ts";

let home = "";
let zdir = "";
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "loki-comp-test-"));
  zdir = join(home, "zfunc");
  mkdirSync(zdir);
  mkdirSync(join(home, ".config", "fish"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const base = () => ({ home, env: {} as NodeJS.ProcessEnv, version: "9.9.9", fpath: [zdir] });

describe("autoInstall", () => {
  test("writes bash, fish and zsh files into auto-loaded locations and clears zcompdump", () => {
    writeFileSync(join(home, ".zcompdump"), "x");
    writeFileSync(join(home, ".zcompdump-host-5.9"), "x");
    const r = autoInstall(base());
    expect(r.status).toBe("installed");
    expect(existsSync(join(home, ".local/share/bash-completion/completions/loki"))).toBe(true);
    expect(existsSync(join(home, ".config/fish/completions/loki.fish"))).toBe(true);
    expect(existsSync(join(zdir, "_loki"))).toBe(true);
    expect(existsSync(join(home, ".zcompdump"))).toBe(false);
    expect(existsSync(join(home, ".zcompdump-host-5.9"))).toBe(false);
    expect(readFileSync(join(home, ".loki/completions-version"), "utf8").trim()).toBe("9.9.9");
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
    expect(existsSync(join(home, ".bashrc"))).toBe(false);
  });

  test("the version stamp prevents a second write; a new version rewrites", () => {
    autoInstall(base());
    rmSync(join(zdir, "_loki"));
    expect(autoInstall(base()).status).toBe("current");
    expect(existsSync(join(zdir, "_loki"))).toBe(false);
    expect(autoInstall({ ...base(), version: "9.9.10" }).status).toBe("installed");
    expect(existsSync(join(zdir, "_loki"))).toBe(true);
  });

  test("skips under CI, LOKI_NO_COMPLETIONS=1, and non-TTY on the first-run path", () => {
    expect(autoInstall({ ...base(), env: { CI: "1" } }).status).toBe("skipped");
    expect(autoInstall({ ...base(), env: { LOKI_NO_COMPLETIONS: "1" } }).status).toBe("skipped");
    expect(autoInstall({ ...base(), requireTty: true, tty: false }).status).toBe("skipped");
    expect(existsSync(join(home, ".loki"))).toBe(false);
    expect(autoInstall({ ...base(), requireTty: true, tty: true }).status).toBe("installed");
  });

  test("never throws on an unwritable home", () => {
    expect(() => autoInstall({ ...base(), home: "/proc/definitely/not/writable" })).not.toThrow();
  });
});

describe("__complete kinds", () => {
  test("providers come from providers/*.sh, runs from .loki/runs", () => {
    const p = completeKind("providers");
    expect(p).toContain("claude");
    expect(p).not.toContain("loader");
    mkdirSync(join(home, ".loki", "runs", "run-a"), { recursive: true });
    expect(completeKind("runs", { cwd: home })).toEqual(["run-a"]);
    expect(completeKind("models").length).toBeGreaterThan(0);
  });
  test("workspaces parse loki.yaml; issues read the cache only", () => {
    writeFileSync(join(home, "loki.yaml"), "workspaces:\n  web:\n    path: a\n  api:\n    path: b\nother: 1\n");
    expect(completeKind("workspaces", { cwd: home })).toEqual(["web", "api"]);
    mkdirSync(join(home, ".loki", "cache"), { recursive: true });
    writeFileSync(join(home, ".loki", "cache", "issues.txt"), "#1\n#2\n");
    expect(completeKind("issues", { home, cwd: home })).toEqual(["#1", "#2"]);
  });
});
