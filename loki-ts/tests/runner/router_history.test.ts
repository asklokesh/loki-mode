// Tests for src/runner/router/history.ts -- H4 per-repo, per-shape outcome history, the
// Sonnet evidence floor, and the shipped shape-defaults reader. Pure logic plus file IO on a
// temp cache root; no provider is called.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HISTORY_FILE,
  appendRunOutcome,
  haikuFloorExecutor,
  readRunHistory,
  shapeDefault,
  shapeKey,
  shapeKeyForRepo,
} from "../../src/runner/router/history.ts";
import { repoCacheDir } from "../../src/engine10/cache.ts";
import type { ProjectModel } from "../../src/project_model/schema.ts";

function model(workspaceKind: string, runners: Array<string | null>): ProjectModel {
  return {
    schema: "loki.v10.project/1",
    status: "ok",
    key: "k",
    workspaceKind,
    workspaceCite: [],
    packages: runners.map((runner, i) => ({
      name: `p${i}`,
      root: i === 0 ? "." : `pkg${i}`,
      runner,
      commands: { test: null, lint: null, build: null, start: null },
      ui: { present: false, boot: null, cite: [] },
      cite: [],
    })),
    fingerprintFiles: [],
  };
}

const HISTORY_KEY = "repo-under-test";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "router-history-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("shapeKey", () => {
  it("joins workspaceKind and sorted, lowercased, de-duplicated runners", () => {
    expect(shapeKey(model("multi-root", ["Vitest", "pytest", "vitest"]))).toBe("multi-root:pytest+vitest");
  });

  it("contributes none for a package with no runner", () => {
    expect(shapeKey(model("single", [null]))).toBe("single:none");
    expect(shapeKey(model("multi-root", ["pytest", null]))).toBe("multi-root:none+pytest");
  });

  it("returns null for an unknown or absent model", () => {
    expect(shapeKey(null)).toBeNull();
    const unknown: ProjectModel = { ...model("unknown", []), status: "unknown" };
    expect(shapeKey(unknown)).toBeNull();
  });

  it("is stable across package order", () => {
    expect(shapeKey(model("multi-root", ["pytest", "vitest"]))).toBe(shapeKey(model("multi-root", ["vitest", "pytest"])));
  });
});

describe("shapeKeyForRepo", () => {
  it("returns null when the repo has no Project Model file", () => {
    expect(shapeKeyForRepo(root)).toBeNull();
  });

  it("reads the cached Project Model and derives the key from it", () => {
    // The validator requires every claim to cite a real file, so the fixture writes one.
    writeFileSync(join(root, "package.json"), "{}");
    const cited = ["package.json"];
    const m: ProjectModel = {
      ...model("single", ["vitest"]),
      workspaceCite: cited,
      fingerprintFiles: cited,
      packages: [{ ...model("single", ["vitest"]).packages[0]!, cite: cited, ui: { present: false, boot: null, cite: cited } }],
    };
    mkdirSync(join(root, ".loki"), { recursive: true });
    writeFileSync(join(root, ".loki", "project.json"), JSON.stringify({ ...m, key: "abc" }));
    expect(shapeKeyForRepo(root)).toBe("single:vitest");
  });
});

describe("run history (H4)", () => {
  const cache = () => root;

  it("cold read is an empty list", () => {
    expect(readRunHistory(HISTORY_KEY, cache())).toEqual([]);
  });

  it("append then read returns the outcomes in order", () => {
    appendRunOutcome(HISTORY_KEY, { shape: "single:vitest", executor: "haiku", verdict: "pass", escalated: false, usd: 0.1, wallS: 12 }, cache());
    appendRunOutcome(HISTORY_KEY, { shape: "single:vitest", executor: "sonnet", verdict: "fail", escalated: true, usd: 0.4, wallS: 30 }, cache());
    const runs = readRunHistory(HISTORY_KEY, cache());
    expect(runs.map((r) => r.executor)).toEqual(["haiku", "sonnet"]);
    expect(runs[1]?.escalated).toBe(true);
  });

  it("writes into the per-repo cache dir from engine10/cache.ts", () => {
    appendRunOutcome(HISTORY_KEY, { shape: "single:vitest", executor: "haiku", verdict: "pass", escalated: false, usd: 0, wallS: 1 }, cache());
    expect(readFileSync(join(repoCacheDir(HISTORY_KEY, cache()), HISTORY_FILE), "utf8")).toContain("single:vitest");
  });

  it("a corrupt history file is a cold read, never a crash", () => {
    const dir = repoCacheDir(HISTORY_KEY, cache());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, HISTORY_FILE), "{not json");
    expect(readRunHistory(HISTORY_KEY, cache())).toEqual([]);
    // Appending onto a corrupt file recovers instead of throwing.
    expect(() => appendRunOutcome(HISTORY_KEY, { shape: "s", executor: "haiku", verdict: "pass", escalated: false, usd: 0, wallS: 1 }, cache())).not.toThrow();
    expect(readRunHistory(HISTORY_KEY, cache())).toHaveLength(1);
  });

  it("drops entries of the wrong shape instead of crashing", () => {
    const dir = repoCacheDir(HISTORY_KEY, cache());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, HISTORY_FILE), JSON.stringify({ runs: [{ shape: 3 }, null, { shape: "s", executor: "haiku", verdict: "pass", escalated: false, usd: 0, wallS: 1 }] }));
    expect(readRunHistory(HISTORY_KEY, cache()).map((r) => r.shape)).toEqual(["s"]);
  });
});

describe("haiku floor", () => {
  const base = { shape: "multi-root:pytest+vitest", escalated: false, usd: 0, wallS: 1 };
  const cache = () => root;

  it("routes to sonnet when haiku lost 2 of its last 3 runs on the shape", () => {
    appendRunOutcome(HISTORY_KEY, { ...base, executor: "haiku", verdict: "fail" }, cache());
    appendRunOutcome(HISTORY_KEY, { ...base, executor: "haiku", verdict: "pass" }, cache());
    appendRunOutcome(HISTORY_KEY, { ...base, executor: "haiku", verdict: "fail" }, cache());
    expect(haikuFloorExecutor(HISTORY_KEY, base.shape, cache())).toBe("sonnet");
  });

  it("keeps haiku when it lost only 1 of its last 3 runs", () => {
    appendRunOutcome(HISTORY_KEY, { ...base, executor: "haiku", verdict: "fail" }, cache());
    appendRunOutcome(HISTORY_KEY, { ...base, executor: "haiku", verdict: "pass" }, cache());
    appendRunOutcome(HISTORY_KEY, { ...base, executor: "haiku", verdict: "pass" }, cache());
    expect(haikuFloorExecutor(HISTORY_KEY, base.shape, cache())).toBe("haiku");
  });

  it("ignores runs on other shapes and sonnet runs", () => {
    appendRunOutcome(HISTORY_KEY, { ...base, executor: "haiku", verdict: "fail" }, cache());
    appendRunOutcome(HISTORY_KEY, { ...base, executor: "haiku", verdict: "fail" }, cache());
    appendRunOutcome(HISTORY_KEY, { ...base, shape: "single:vitest", executor: "haiku", verdict: "fail" }, cache());
    appendRunOutcome(HISTORY_KEY, { ...base, executor: "sonnet", verdict: "fail" }, cache());
    expect(haikuFloorExecutor(HISTORY_KEY, base.shape, cache())).toBe("haiku");
  });

  it("is haiku with no history or a null shape", () => {
    expect(haikuFloorExecutor(HISTORY_KEY, base.shape, cache())).toBe("haiku");
    expect(haikuFloorExecutor(HISTORY_KEY, null, cache())).toBe("haiku");
  });
});

describe("shapeDefault (shipped router-shape-defaults.json)", () => {
  it("the shipped file is an empty map: no shape is listed yet", () => {
    expect(shapeDefault("multi-root:pytest+vitest")).toBeNull();
    expect(shapeDefault("single:none")).toBeNull();
  });

  it("returns null for a null key", () => {
    expect(shapeDefault(null)).toBeNull();
  });

  it("reads a listed sonnet shape and ignores any other executor value", () => {
    const file = join(root, "defaults.json");
    writeFileSync(file, JSON.stringify({ shapes: { "multi-root:pytest+vitest": { executor: "sonnet", evidence: "METRICS row" }, "single:none": { executor: "haiku" } } }));
    expect(shapeDefault("multi-root:pytest+vitest", file)).toBe("sonnet");
    expect(shapeDefault("single:none", file)).toBeNull();
    expect(shapeDefault("absent", file)).toBeNull();
  });

  it("a corrupt or missing file is an empty map, never a throw", () => {
    const corrupt = join(root, "corrupt.json");
    writeFileSync(corrupt, "{oops");
    expect(() => shapeDefault("single:none", corrupt)).not.toThrow();
    expect(shapeDefault("single:none", corrupt)).toBeNull();
    expect(shapeDefault("single:none", join(root, "missing.json"))).toBeNull();
  });
});
