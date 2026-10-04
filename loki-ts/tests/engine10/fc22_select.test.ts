// FC-22a: package-scoped impacted-test selection (FireLater#17). A backend change must not select a frontend test
// unless the frontend declares it depends on the backend. Every doubt keeps today's selection.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestMap, impactedRefs } from "../../src/engine10/testmap.ts";
import { allowedRoots, scopedOutOf } from "../../src/project_model/scope.ts";
import { projectApi } from "../../src/project_model/api.ts";
import { loadProjectApi } from "../../src/project_model/resolve.ts";
import { hasRelevantTests } from "../../src/engine10/sizing.ts";
import type { ProjectModel } from "../../src/project_model/schema.ts";

const FIX = join(import.meta.dir, "..", "fixtures", "monorepo-fc22");
const dirs: string[] = [];
// tests/preload.ts turns the model off by default; this suite needs it on.
const savedEnv = process.env["LOKI_E10_PROJECT_MODEL"];
beforeEach(() => { process.env["LOKI_E10_PROJECT_MODEL"] = "1"; process.env["LOKI_E10_SCOPE"] = "1"; });
afterEach(() => { delete process.env["LOKI_E10_SCOPE"]; if (savedEnv === undefined) delete process.env["LOKI_E10_PROJECT_MODEL"]; else process.env["LOKI_E10_PROJECT_MODEL"] = savedEnv; while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const cmd = (cwd: string) => ({ cmd: "npx vitest run", cwd, cite: [`${cwd}/package.json`] });
const pkg = (name: string, dependsOn?: string[]) => ({
  name, root: name, runner: "vitest", cite: [`${name}/package.json`],
  commands: { test: cmd(name), lint: null, build: null, start: null },
  ui: { present: false, boot: null, cite: [`${name}/package.json`] },
  ...(dependsOn ? { dependsOn } : {}),
});
function repo(packages: unknown[] | null): string {
  const d = mkdtempSync(join(tmpdir(), "fc22-"));
  dirs.push(d);
  cpSync(FIX, d, { recursive: true });
  if (packages) {
    const model = { schema: "loki.v10.project/1", status: "ok", key: "k", workspaceKind: "multi-root", workspaceCite: ["backend/package.json"], packages, fingerprintFiles: ["backend/package.json"] };
    mkdirSync(join(d, ".loki"), { recursive: true });
    writeFileSync(join(d, ".loki", "project.json"), JSON.stringify(model));
  }
  return d;
}
const paths = (d: string, changed: string[]): string[] => impactedRefs(buildTestMap(d), changed).map((r) => r.path).sort();
const B = "backend/src/validation.test.ts", F = "frontend/src/validation.test.ts", T = "tools/validation.test.ts";

const BU = "backend/src/uses.test.ts", FU = "frontend/src/uses.test.ts";
const root = () => ({ ...pkg("root", []), root: ".", cite: ["package.json"], commands: { test: { cmd: "x", cwd: ".", cite: ["package.json"] }, lint: null, build: null, start: null }, ui: { present: false, boot: null, cite: ["package.json"] } });

describe("FC-22a package-scoped selection", () => {
  test("B2: without LOKI_E10_SCOPE=1 selection is unscoped and nothing is recorded", () => {
    delete process.env["LOKI_E10_SCOPE"];
    const d = repo([pkg("backend", []), pkg("frontend", [])]), m = buildTestMap(d);
    expect(impactedRefs(m, ["backend/src/validation.ts"]).map((r) => r.path).sort()).toEqual([B, F, T]);
    expect(scopedOutOf(m)).toEqual([]);
  });
  test("B1: a change owned only by the root package scopes nothing", () => {
    const d = repo([root(), pkg("backend", []), pkg("frontend", [])]);
    expect(paths(d, ["shared/util.ts"])).toEqual([BU, FU]);
  });
  test("B1: a root-owned test is never scoped out", () => {
    const d = repo([root(), pkg("backend", []), pkg("frontend", [])]);
    writeFileSync(join(d, "root.test.ts"), 'import { test } from "bun:test";\nimport { validate } from "./backend/src/validation";\ntest("r", () => {});\n');
    expect(paths(d, ["backend/src/validation.ts"])).toContain("root.test.ts");
    expect(paths(d, ["backend/src/validation.ts"])).not.toContain(F);
  });
  test("B1: an absolute changed path never scopes", () => {
    const d = repo([pkg("backend", []), pkg("frontend", [])]);
    expect(paths(d, [join(d, "backend/src/validation.ts")])).toContain(F);
  });
  test("A1: a test importing the changed file is kept despite dependsOn []", () => {
    const d = repo([pkg("backend", []), pkg("frontend", [])]);
    writeFileSync(join(d, "frontend/src/direct.test.ts"), 'import { test } from "bun:test";\nimport { validate } from "../../backend/src/validation";\ntest("d", () => { validate("x"); });\n');
    const got = paths(d, ["backend/src/validation.ts"]);
    expect(got).toContain("frontend/src/direct.test.ts");
    expect(got).not.toContain(F);
  });
  test("A1: nested package import is kept", () => {
    const d = repo([pkg("backend", []), pkg("frontend", [])]);
    mkdirSync(join(d, "backend/sub"), { recursive: true });
    writeFileSync(join(d, "backend/sub/x.ts"), "export const x = 1;\n");
    writeFileSync(join(d, "frontend/src/nest.test.ts"), 'import { test } from "bun:test";\nimport { x } from "../../backend/sub/x.ts";\ntest("n", () => { void x; });\n');
    expect(paths(d, ["backend/sub/x.ts"])).toContain("frontend/src/nest.test.ts");
  });
  test("model loads from the repo cache", () => {
    expect(loadProjectApi(repo([pkg("backend", []), pkg("frontend", [])]))?.packages().length).toBe(2);
  });
  test("a backend-only change selects no frontend test, keeps the unowned test", () => {
    expect(paths(repo([pkg("backend", []), pkg("frontend", [])]), ["backend/src/validation.ts"])).toEqual([B, T]);
  });
  test("a frontend that depends on the backend keeps its test", () => {
    expect(paths(repo([pkg("backend", []), pkg("frontend", ["backend"])]), ["backend/src/validation.ts"])).toEqual([B, F, T]);
  });
  test("absent dependsOn keeps today's selection", () => {
    const d = repo([pkg("backend", []), pkg("frontend")]);
    expect(paths(d, ["backend/src/validation.ts"])).toEqual(paths(repo(null), ["backend/src/validation.ts"]));
    expect(paths(d, ["backend/src/validation.ts"])).toEqual([B, F, T]);
  });
  test("single-package model is byte-identical to no model", () => {
    const none = repo(null), one = repo([{ ...pkg("backend", []), root: "." }]);
    expect(JSON.stringify(impactedRefs(buildTestMap(one), ["backend/src/validation.ts"]))).toBe(JSON.stringify(impactedRefs(buildTestMap(none), ["backend/src/validation.ts"])));
  });
  test("a changed file with no owning package disables scoping", () => {
    expect(paths(repo([pkg("backend", []), pkg("frontend", [])]), ["tools/other.ts", "backend/src/validation.ts"])).toEqual([B, F, T]);
  });
  test("scoped-out tests are recorded for the verify event", () => {
    const m = buildTestMap(repo([pkg("backend", []), pkg("frontend", [])]));
    impactedRefs(m, ["backend/src/validation.ts"]);
    expect(scopedOutOf(m)).toEqual([F]);
  });
  test("hasRelevantTests uses the same scoped mechanism", () => {
    const m = buildTestMap(repo([pkg("backend", []), pkg("frontend", [])]));
    const calls: string[][] = [];
    hasRelevantTests("fix frontend/src/validation.ts", null, m, (mm, files) => { const r = impactedRefs(mm, files); calls.push(r.map((x) => x.path)); return r; });
    expect(calls.flat()).not.toContain(B);
  });
  test("allowedRoots: owners plus transitive dependents", () => {
    const model = { schema: "loki.v10.project/1", status: "ok", key: "k", workspaceKind: "x", workspaceCite: [], fingerprintFiles: [], packages: [pkg("a", []), pkg("b", ["a"]), pkg("c", ["b"]), pkg("d", [])] } as unknown as ProjectModel;
    expect([...allowedRoots(projectApi(model), ["a/x.ts"])!].sort()).toEqual(["a", "b", "c"]);
  });
});
