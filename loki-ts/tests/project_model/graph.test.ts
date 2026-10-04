// loki-ts/tests/project_model/graph.test.ts -- FC-22a (S1) wall checks: dependsOn schema, dependentsOf, model-rev salt.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectApi } from "../../src/project_model/api.ts";
import { computeKey } from "../../src/project_model/gather.ts";
import { dependentsOf, edgesKnown } from "../../src/project_model/graph.ts";
import { parseCached, validateAnswer, type ProjectModel } from "../../src/project_model/schema.ts";

const FIX = join(import.meta.dir, "..", "fixtures", "project-model", "firelater-17");
const RECORDED = JSON.parse(readFileSync(join(FIX, "response.json"), "utf8")) as Record<string, any>;
const dirs: string[] = [];
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "pm-graph-"));
  dirs.push(d);
  cpSync(FIX, d, { recursive: true });
  rmSync(join(d, "response.json"));
  execFileSync("git", ["init", "-q"], { cwd: d, stdio: "pipe", env: process.env });
  return d;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const clone = (): Record<string, any> => JSON.parse(JSON.stringify(RECORDED));

function model(edges: Record<string, string[] | undefined>): ProjectModel {
  return {
    schema: "loki.v10.project/1", status: "ok", key: "k", workspaceKind: "multi-root", workspaceCite: [], fingerprintFiles: [],
    packages: Object.entries(edges).map(([root, dependsOn]) => ({
      name: root, root, runner: null, cite: [], ui: { present: false, boot: null, cite: [] },
      commands: { test: null, lint: null, build: null, start: null },
      ...(dependsOn === undefined ? {} : { dependsOn }),
    })),
  };
}

describe("schema dependsOn and install", () => {
  test("an unknown dependsOn root is rejected", () => {
    const a = clone();
    a.packages[1].dependsOn = ["nope"];
    const r = validateAnswer(repo(), a);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join("\n")).toContain('dependsOn: "nope" is not the root of any listed package');
  });
  test("an absent dependsOn validates and stays absent", () => {
    const a = clone();
    for (const p of a.packages) { delete p.dependsOn; delete p.install; }
    const r = validateAnswer(repo(), a);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.model.packages.every((p) => p.dependsOn === undefined && p.install === undefined)).toBe(true);
      expect(projectApi({ ...r.model, key: "k" }).dependsOn("frontend")).toBeNull();
    }
  });
  test("a declared edge and a cited install are kept; install must cite an existing file", () => {
    const a = clone();
    a.packages[1].dependsOn = ["backend"];
    const r = validateAnswer(repo(), a);
    expect(r.ok && r.model.packages[1]!.dependsOn).toEqual(["backend"]);
    expect(r.ok && r.model.packages[0]!.install?.cmd).toBe("npm ci");
    a.packages[0].install.cite = ["missing.json"];
    const bad = validateAnswer(repo(), a);
    expect(!bad.ok && bad.errors.join("\n")).toContain("packages[0].install.cite");
  });
  test("the fixture has backend and frontend with no edge between them", () => {
    const r = validateAnswer(repo(), clone());
    expect(r.ok).toBe(true);
    if (r.ok) expect(dependentsOf({ ...r.model, key: "k" }, ["backend"])).toEqual([]);
  });
});

describe("dependentsOf", () => {
  test("is transitive", () => {
    const m = model({ core: [], api: ["core"], web: ["api"], other: [] });
    expect(dependentsOf(m, ["core"])).toEqual(["api", "web"]);
  });
  test("ignores cycles and never returns the input roots", () => {
    const m = model({ a: ["b"], b: ["c"], c: ["a"], d: ["a"] });
    expect(dependentsOf(m, ["a"])).toEqual(["b", "c", "d"]);
  });
  test("absent dependsOn contributes no edges; edgesKnown reports it", () => {
    const m = model({ a: [], b: undefined });
    expect(dependentsOf(m, ["a"])).toEqual([]);
    expect(edgesKnown(m)).toBe(false);
    expect(edgesKnown(model({ a: [], b: ["a"] }))).toBe(true);
  });
  test("an unknown model has no dependents", () => {
    expect(dependentsOf({ ...model({ a: [] }), status: "unknown" }, ["a"])).toEqual([]);
  });
});

describe("model-rev:2 salt", () => {
  test("a rev-1 key (hash without the rev salt) mismatches the current key, so the cached model is rediscovered", () => {
    const d = repo();
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const files = ["backend/package.json"];
    const h = createHash("sha256");
    h.update("file:backend/package.json\n");
    h.update(readFileSync(join(d, "backend/package.json")));
    h.update("\n");
    h.update("dir:backend\n");
    const rev1 = h.digest("hex");
    expect(computeKey(d, files, ["backend"])).not.toBe(rev1);
    expect(computeKey(d, files, ["backend"])).toBe(computeKey(d, files, ["backend"]));
  });
  test("a cached rev-1 model file still parses (shape unchanged); only the key differs", () => {
    const d = repo();
    const r = validateAnswer(d, clone());
    expect(r.ok).toBe(true);
    if (r.ok) expect(parseCached(d, { ...r.model, key: "old" }, Date.now())?.key).toBe("old");
  });
});
