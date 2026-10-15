// LM-004: the capability table covers every supported provider, docs/cost-controls.md carries its engine10 rows,
// and the disclosure line is empty for claude and names the gap for the others.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITIES, COLUMNS, PROVIDERS, capability, disclosureLine, matrixText, providerSandboxFlags } from "../../src/providers/provider_guard.ts";
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
