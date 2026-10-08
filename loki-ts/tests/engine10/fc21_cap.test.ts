// FC-21b (2): the run cap is sized from the plan scope (packages + dependents, file count), not task text or repo size.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CAP_S } from "../../src/engine10/types.ts";
import { projectApi } from "../../src/project_model/api.ts";
import type { ModelPackage, ProjectModel } from "../../src/project_model/schema.ts";
import { MAX_SCOPE_BYTES, capCeilingS, readPlanScope, readScopeText, resizeCap, resolveRunCapS, scopeCapS, yamlRunCapS } from "../../src/util/run_cap.ts";

const pkg = (root: string, dependsOn?: string[]): ModelPackage => ({ name: root, root, runner: null, commands: { test: null, lint: null, build: null, start: null }, ui: { present: false, boot: null, cite: [] }, cite: [], ...(dependsOn ? { dependsOn } : {}) });
const model = (packages: ModelPackage[]): ProjectModel => ({ schema: "loki.v10.project/1", status: "ok", key: "k", workspaceKind: "workspaces", workspaceCite: [], packages, fingerprintFiles: [] });
const api = projectApi(model([pkg("a", []), pkg("b", ["a"]), pkg("c", []), pkg("d", [])]));
const many = projectApi(model(Array.from({ length: 12 }, (_, i) => pkg(`p${i}`, []))));

describe("scopeCapS", () => {
  test("a 4-package, 4-file scope gets a larger cap than a 1-file scope", () => {
    const big = scopeCapS(["a/x.ts", "b/x.ts", "c/x.ts", "d/x.ts"], api, true);
    expect(big).toBeGreaterThan(scopeCapS(["a/x.ts"], api, true));
    expect(big).toBe(900 + 450 * 3 + 20);
  });
  test("a 1-file scope gets 900", () => { expect(scopeCapS(["c/x.ts"], api, true)).toBe(DEFAULT_CAP_S); });
  test("dependents of an owning package count", () => { expect(scopeCapS(["a/x.ts"], api, true)).toBe(900 + 450); });
  test("no scope or no model sizes as one package", () => {
    expect(scopeCapS([], api, true)).toBe(DEFAULT_CAP_S);
    expect(scopeCapS(["a/x.ts", "b/y.ts"], null, true)).toBe(DEFAULT_CAP_S);
    expect(scopeCapS(["a/1", "a/2", "a/3", "a/4", "a/5"], null, true)).toBe(900 + 40);
  });
  test("the clamp holds at both ends", () => {
    const files = Array.from({ length: 12 }, (_, i) => `p${i}/x.ts`);
    expect(scopeCapS(files, many, true)).toBe(capCeilingS(true));
    expect(scopeCapS(files, many, true)).toBe(3600);
    expect(scopeCapS(files, many, false)).toBe(2400);
    expect(scopeCapS(["z/x.ts"], api, false)).toBe(DEFAULT_CAP_S);
    expect(scopeCapS([], null, false)).toBeGreaterThanOrEqual(DEFAULT_CAP_S);
  });
});

describe("resizeCap and resolveRunCapS", () => {
  const dir = mkdtempSync(join(tmpdir(), "fc21cap-"));
  const withScope = (files: unknown): string => { const d = mkdtempSync(join(dir, "r-")); writeFileSync(join(d, "plan-scope.json"), JSON.stringify({ files })); return d; };
  test("a long task text with a 1-file scope gets 900 (text is not a signal)", () => {
    const r = withScope(["c/x.ts"]);
    expect(resizeCap(r, api, true)).toBe(900);
    const repo = mkdtempSync(join(dir, "repo-"));
    expect(resolveRunCapS(repo, true, {}).capS).toBe(900);
  });
  test("scope is read from plan-scope.json; malformed or missing is empty", () => {
    expect(readPlanScope(withScope(["a/x.ts", "a/x.ts", " ", 3]))).toEqual(["a/x.ts"]);
    expect(readPlanScope(join(dir, "missing"))).toEqual([]);
    const d = mkdtempSync(join(dir, "bad-")); writeFileSync(join(d, "plan-scope.json"), "not json");
    expect(readPlanScope(d)).toEqual([]);
  });
  test("resize grows the cap for a wide scope", () => { expect(resizeCap(withScope(["a/x", "b/x", "c/x", "d/x"]), api, true)).toBe(2270); });
  test("explicit env and yaml caps are fixed and win, even over the ceiling", () => {
    const wide = withScope(["a/x", "b/x", "c/x", "d/x"]);
    expect(resizeCap(wide, api, true, 300)).toBe(300);
    expect(resizeCap(wide, api, true, 9000)).toBe(9000);
    const repo = mkdtempSync(join(dir, "y-")); writeFileSync(join(repo, "loki.yaml"), "budgets:\r\n  run_cap_s: 1234\r\n");
    expect(resolveRunCapS(repo, true, {})).toEqual({ capS: 1234, fixedS: 1234, ceilingS: 1234 });
    expect(resolveRunCapS(repo, true, { LOKI_E10_CAP_S: "600" })).toEqual({ capS: 600, fixedS: 600, ceilingS: 600 });
    expect(resolveRunCapS(mkdtempSync(join(dir, "n-")), false, {})).toEqual({ capS: 900, fixedS: undefined, ceilingS: 2400 });
  });
  test("cleanup", () => { rmSync(dir, { recursive: true, force: true }); });
});

describe("yamlRunCapS", () => {
  test("reads budgets.run_cap_s only", () => {
    expect(yamlRunCapS("budgets:\n  per_run: 3\n  run_cap_s: 3600\n")).toBe(3600);
    expect(yamlRunCapS("budgets:\n  per_run: 3\n")).toBeNull();
  });
  test("a nested per_stage run_cap_s is ignored", () => {
    expect(yamlRunCapS("budgets:\n  per_stage:\n    run_cap_s: 99\n")).toBeNull();
    expect(yamlRunCapS("other:\n  run_cap_s: 99\n")).toBeNull();
  });
  test("CRLF yaml is read", () => { expect(yamlRunCapS("budgets:\r\n  per_run: 3\r\n  run_cap_s: 1500\r\n")).toBe(1500); });
});

describe("plan brief", () => {
  test("asks the session for plan-scope.json next to the plan output", async () => {
    const { buildPlanBrief } = await import("../../src/engine10/stages/plan.ts");
    expect(buildPlanBrief("t", [], "/r/plan-output.txt")).toContain("/r/plan-scope.json");
  });
});

describe("R1-10b: plan-scope.json guarded read (shared by run_cap and plan)", () => {
  const mk = () => mkdtempSync(join(tmpdir(), "scope-guard-"));
  const good = JSON.stringify({ files: ["a/x.ts"] });
  test("a valid regular file is read", () => {
    const d = mk(); writeFileSync(join(d, "plan-scope.json"), good);
    expect(readScopeText(d)).toEqual({ status: "ok", text: good });
    expect(readPlanScope(d)).toEqual(["a/x.ts"]);
    rmSync(d, { recursive: true, force: true });
  });
  test("a symlink to a regular file is rejected", () => {
    const d = mk(); writeFileSync(join(d, "real.json"), good); symlinkSync(join(d, "real.json"), join(d, "plan-scope.json"));
    expect(readScopeText(d).status).toBe("not_file");
    expect(readPlanScope(d)).toEqual([]);
    rmSync(d, { recursive: true, force: true });
  });
  test("a directory is rejected", () => {
    const d = mk(); mkdirSync(join(d, "plan-scope.json"));
    expect(readScopeText(d).status).toBe("not_file");
    expect(readPlanScope(d)).toEqual([]);
    rmSync(d, { recursive: true, force: true });
  });
  test("a file over the cap is rejected", () => {
    const d = mk(); writeFileSync(join(d, "plan-scope.json"), JSON.stringify({ files: ["a/x.ts"], pad: "x".repeat(MAX_SCOPE_BYTES) }));
    expect(readScopeText(d).status).toBe("too_big");
    expect(readPlanScope(d)).toEqual([]);
    rmSync(d, { recursive: true, force: true });
  });
  test("a missing file reports missing", () => {
    const d = mk(); expect(readScopeText(d).status).toBe("missing"); rmSync(d, { recursive: true, force: true });
  });
});
