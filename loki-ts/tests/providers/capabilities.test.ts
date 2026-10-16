// LM-004: the capability table covers every supported provider, docs/cost-controls.md carries its engine10 rows,
// and the disclosure line is empty for claude and names the gap for the others.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CAPABILITIES, COLUMNS, PROVIDERS, beginGuard, capability, disclosureLine, finishGuard, isGuarded, matrixText, providerSandboxFlags } from "../../src/providers/provider_guard.ts";
import { runProviderInfoJson } from "../../src/commands/provider.ts";
import { REPO_ROOT } from "../../src/util/paths.ts";

describe("capability table", () => {
  test("every provider the loader supports has an engine10 and a legacy row", () => {
    const loader = readFileSync(join(REPO_ROOT, "providers", "loader.sh"), "utf8");
    const m = /^SUPPORTED_PROVIDERS=\(([^)]*)\)/m.exec(loader);
    expect(m).not.toBeNull();
    const supported = m![1]!.split(/\s+/).map((x) => x.replace(/"/g, "")).filter(Boolean);
    expect([...supported].sort()).toEqual([...PROVIDERS].sort());
    for (const p of supported) for (const e of ["engine10", "legacy"] as const) expect(capability(p, e)).toBeDefined();
    expect(CAPABILITIES.length).toBe(supported.length * 2);
  });

  test("engine10 sandbox flags match the guard module", () => {
    for (const p of PROVIDERS) expect(capability(p, "engine10")!.sandboxFlags).toEqual(providerSandboxFlags(p));
  });

  test("every row cites a source", () => {
    for (const r of CAPABILITIES) expect(r.source.length).toBeGreaterThan(10);
  });

  test("docs/cost-controls.md carries every engine10 row", () => {
    const doc = readFileSync(join(REPO_ROOT, "docs", "cost-controls.md"), "utf8");
    const cell = (v: string | string[]): string => (Array.isArray(v) ? (v.length ? v.join(" ") : "none") : v);
    for (const r of CAPABILITIES.filter((c) => c.engine === "engine10")) expect(doc).toContain(`| ${COLUMNS.map((c) => cell(r[c])).join(" | ")} |`);
  });

  test("matrix lists every row", () => {
    expect(matrixText().trim().split("\n").length).toBe(CAPABILITIES.length + 1);
  });
});

describe("disclosure", () => {
  test("claude prints nothing extra", () => expect(disclosureLine("claude")).toBeNull());
  test("opencode names cost and budget gaps", () => {
    const l = disclosureLine("opencode")!;
    expect(l.startsWith("opencode on engine10:")).toBe(true);
    expect(l).toContain("cost not measured");
    expect(l).toContain("no budget kill");
  });
  test("codex says estimated cost and kill blocking not enforced", () => {
    const l = disclosureLine("codex")!;
    expect(l).toContain("cost estimated");
    expect(l).toContain("kill blocking not enforced");
    expect(l).not.toContain("budget kill");
  });
  test("one line, plain ascii", () => {
    for (const p of PROVIDERS) { const l = disclosureLine(p); if (l) { expect(l.includes("\n")).toBe(false); expect(/^[\x20-\x7e]+$/.test(l)).toBe(true); } }
  });
  test("info --json rejects an unknown provider", () => {
    expect(runProviderInfoJson("nope")).toBe(1);
  });
});

// P12-25 (E06): the same isolation assertions run once per provider. A provider row with no isolation layer goes red.
function makeRepo(): { dir: string; backup: string } {
  const dir = mkdtempSync(join(tmpdir(), "iso-matrix-"));
  const backup = mkdtempSync(join(tmpdir(), "iso-backup-"));
  const g = (...a: string[]) => spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  g("init", "-q");
  for (let i = 0; i < 10; i++) writeFileSync(join(dir, `f${i}.txt`), `x${i}\n`);
  g("add", "."); g("commit", "-q", "-m", "init");
  return { dir, backup };
}

describe("per-provider isolation matrix", () => {
  for (const p of PROVIDERS) {
    describe(p, () => {
      const row = capability(p, "engine10")!;
      test("declares an isolation layer", () => {
        expect(row.cancelProcessGroup).toBe("yes");
        if (p === "claude") {
          expect(isGuarded(p)).toBe(false);
          expect(row.guardScan).toBe("native");
          expect(row.killBlocking).toBe("native");
        } else {
          expect(isGuarded(p)).toBe(true);
          expect(row.guardScan).toBe("post-iteration");
          expect(row.killBlocking).toBe("none");
          expect(row.sandboxFlags).toEqual(providerSandboxFlags(p));
        }
      });
      if (p === "claude") return;
      test("guard reverts repo deletion, .git/config edits, new hooks and escaping symlinks", () => {
        const { dir, backup } = makeRepo();
        try {
          const snap = beginGuard(dir, backup)!;
          expect(snap).not.toBeNull();
          for (let i = 0; i < 10; i++) rmSync(join(dir, `f${i}.txt`));
          writeFileSync(join(dir, ".git", "config"), readFileSync(join(dir, ".git", "config"), "utf8") + "\n[alias]\n\tx = status\n");
          mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
          writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n"); chmodSync(join(dir, ".git", "hooks", "pre-commit"), 0o755);
          symlinkSync("/etc", join(dir, "escape"));
          const r = finishGuard(snap);
          expect(r.ok).toBe(false);          expect(new Set(r.violations.map((v) => v.kind))).toEqual(new Set(["repo-deleted", "git-internals", "outside-project"]));
          for (let i = 0; i < 10; i++) expect(existsSync(join(dir, `f${i}.txt`))).toBe(true);
          expect(existsSync(join(dir, ".git", "hooks", "pre-commit"))).toBe(false);
          expect(existsSync(join(dir, "escape"))).toBe(false);
          expect(readFileSync(join(dir, ".git", "config"), "utf8")).not.toContain("[alias]");
        } finally { rmSync(dir, { recursive: true, force: true }); rmSync(backup, { recursive: true, force: true }); }
      });
      test("clean iteration passes the guard", () => {
        const { dir, backup } = makeRepo();
        try {
          const snap = beginGuard(dir, backup)!;
          writeFileSync(join(dir, "new.txt"), "ok\n");
          expect(finishGuard(snap).ok).toBe(true);
        } finally { rmSync(dir, { recursive: true, force: true }); rmSync(backup, { recursive: true, force: true }); }
      });
    });
  }
});
