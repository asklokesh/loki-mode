// Bash-vs-Bun parity tests for `loki wiki show` (R5 auto-wiki).
//
// The bin/loki shim allowlist includes "wiki", so when bun is installed the Bun
// route (loki-ts/src/commands/wiki.ts) is LIVE. Bun implements `show` natively
// (reads .loki/wiki/*.md); `generate` and `ask` delegate to the bash/Python
// core. This file asserts the native `show` output is byte-equal to what bash
// `show` prints and to the rendered markdown the generator wrote, so the Bun
// reader cannot drift from the artifact. generate/ask are covered by the Python
// + bash-CLI tests (one implementation, no parity surface to duplicate).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { run } from "../../src/util/shell.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const BUN_CLI = resolve(REPO_ROOT, "loki-ts", "src", "cli.ts");
const BASH_CLI = resolve(REPO_ROOT, "autonomy", "loki");

let project = "";

async function sh(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  // run() merges process.env internally (see src/util/shell.ts), so pass only
  // the caller-supplied string vars; spreading process.env here would widen the
  // type to Record<string, string | undefined> and break typecheck (TS2322).
  return run(cmd, { cwd, env, timeoutMs: 60000 });
}

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), "loki-wiki-bun-"));
  await sh(["mkdir", "-p", join(project, "src")], project);
  writeFileSync(
    join(project, "src", "app.ts"),
    "export function boot(): number {\n  return start();\n}\n\n" +
      "function start(): number {\n  return 1;\n}\n",
  );
  await sh(["git", "init", "-q"], project);
  await sh(["git", "add", "-A"], project);
  await sh(
    ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
    project,
  );
  // Generate the wiki via the bash route with a stubbed LLM (no paid calls).
  await sh([BASH_CLI, "wiki", "generate"], project, {
    LOKI_LEGACY_BASH: "1",
    LOKI_WIKI_LLM_STUB: "Boot prose [1].",
  });
});

afterEach(() => {
  if (project && existsSync(project)) rmSync(project, { recursive: true, force: true });
});

describe("loki wiki show (Bun native)", () => {
  it("show <section> equals the rendered markdown artifact", async () => {
    const artifact = readFileSync(join(project, ".loki", "wiki", "architecture.md"), "utf8");
    const bun = await sh(["bun", BUN_CLI, "wiki", "show", "architecture"], project);
    expect(bun.exitCode).toBe(0);
    expect(bun.stdout).toBe(artifact);
  });

  it("show (no section) equals the rendered index.md", async () => {
    const artifact = readFileSync(join(project, ".loki", "wiki", "index.md"), "utf8");
    const bun = await sh(["bun", BUN_CLI, "wiki", "show"], project);
    expect(bun.exitCode).toBe(0);
    expect(bun.stdout).toBe(artifact);
  });

  it("Bun show matches bash show byte-for-byte", async () => {
    const bun = await sh(["bun", BUN_CLI, "wiki", "show", "modules"], project);
    const bash = await sh([BASH_CLI, "wiki", "show", "modules"], project, {
      LOKI_LEGACY_BASH: "1",
    });
    expect(bun.stdout).toBe(bash.stdout);
    expect(bun.exitCode).toBe(bash.exitCode);
  });

  it("unknown section is rejected with a non-zero exit", async () => {
    const bun = await sh(["bun", BUN_CLI, "wiki", "show", "bogus"], project);
    expect(bun.exitCode).not.toBe(0);
  });

  it("bad section lists valid sections and exits 2", async () => {
    const bun = await sh(["bun", BUN_CLI, "wiki", "show", "bogus"], project);
    expect(bun.exitCode).toBe(2);
    expect(bun.stdout).toBe("");
    expect(bun.stderr).toContain("No such section: bogus");
    expect(bun.stderr).toContain("Valid sections: architecture, modules, data-flow");
    const ok = await sh(["bun", BUN_CLI, "wiki", "show", "data-flow"], project);
    expect(ok.exitCode).toBe(0);
  });

  it("two sections is a usage error with exit 1 and no output", async () => {
    const bun = await sh(["bun", BUN_CLI, "wiki", "show", "architecture", "modules"], project);
    expect(bun.exitCode).toBe(1);
    expect(bun.stdout).toBe("");
    expect(bun.stderr).toContain("Too many arguments");
  });

  it("show with no wiki prints a hint and exits non-zero", async () => {
    const empty = mkdtempSync(join(tmpdir(), "loki-wiki-none-"));
    try {
      const bun = await sh(["bun", BUN_CLI, "wiki", "show"], empty);
      expect(bun.exitCode).not.toBe(0);
      expect(bun.stderr.toLowerCase()).toContain("generate");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
