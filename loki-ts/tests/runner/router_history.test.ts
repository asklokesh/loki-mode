// Tests for src/runner/router/history.ts -- H4 per-repo, per-shape outcome history, the
// Sonnet evidence floor (code-owned losses only), and the shipped shape-defaults reader.
// Pure logic plus file IO on a temp cache root; no provider is called.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HISTORY_FILE,
  type RunOutcome,
  appendRunOutcome,
  haikuFloorExecutor,
  readRunHistory,
  shapeDefault,
  shapeKey,
  shapeKeyForRepo,
} from "../../src/runner/router/history.ts";
import { repoCacheDir } from "../../src/engine10/cache.ts";
import { computeKey, shallowDirs } from "../../src/project_model/gather.ts";
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
const SHAPE = "multi-root:pytest+vitest";
let root: string;

/** A haiku run; the owner defaults to "code" so that a fail counts as a loss unless a test says otherwise. */
function run(overrides: Partial<RunOutcome>): RunOutcome {
  return { shape: SHAPE, executor: "haiku", verdict: "pass", owner: "code", escalated: false, usd: 0, wallS: 1, ...overrides };
}

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

  it("a fingerprint file that changed after caching gives null (stale key)", () => {
    cacheFreshModel();
    writeFileSync(join(root, "package.json"), '{"changed":true}');
    expect(shapeKeyForRepo(root)).toBeNull();
  });

  it("reads the cached Project Model and derives the key from it when it is fresh", () => {
    cacheFreshModel();
    expect(shapeKeyForRepo(root)).toBe("single:vitest");
  });

  /** A cached model whose key is the real, freshly computed key of the repo as it stands. */
  function cacheFreshModel(): void {
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
    writeFileSync(join(root, ".loki", "project.json"), JSON.stringify({ ...m, key: computeKey(root, cited, shallowDirs(root)) }));
  }
});

describe("run history atomic write", () => {
  it("a failed write leaves the previous history intact and returns false", () => {
    appendRunOutcome(HISTORY_KEY, run({ executor: "haiku" }), root);
    const file = join(repoCacheDir(HISTORY_KEY, root), HISTORY_FILE);
    const before = readFileSync(file, "utf8");
    // Block the temp file: a directory at its name makes the write fail.
    mkdirSync(`${file}.${process.pid}.tmp`);
    expect(appendRunOutcome(HISTORY_KEY, run({ executor: "sonnet" }), root)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readRunHistory(HISTORY_KEY, root)).toHaveLength(1);
  });

  it("leaves no temp file behind on success and keeps the 200 cap", () => {
    for (let i = 0; i < 205; i++) appendRunOutcome(HISTORY_KEY, run({ wallS: i }), root);
    expect(readRunHistory(HISTORY_KEY, root)).toHaveLength(200);
    expect(readdirSync(repoCacheDir(HISTORY_KEY, root)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("run history (H4)", () => {
  const cache = () => root;

  it("cold read is an empty list", () => {
    expect(readRunHistory(HISTORY_KEY, cache())).toEqual([]);
  });

  it("append then read returns the outcomes in order, owner included", () => {
    appendRunOutcome(HISTORY_KEY, run({ executor: "haiku", verdict: "pass", owner: null }), cache());
    appendRunOutcome(HISTORY_KEY, run({ executor: "sonnet", verdict: "fail", owner: "harness", escalated: true }), cache());
    const runs = readRunHistory(HISTORY_KEY, cache());
    expect(runs.map((r) => r.executor)).toEqual(["haiku", "sonnet"]);
    expect(runs[1]?.owner).toBe("harness");
    expect(runs[1]?.escalated).toBe(true);
  });

  it("writes into the per-repo cache dir from engine10/cache.ts", () => {
    appendRunOutcome(HISTORY_KEY, run({ shape: "single:vitest" }), cache());
    expect(readFileSync(join(repoCacheDir(HISTORY_KEY, cache()), HISTORY_FILE), "utf8")).toContain("single:vitest");
  });

  it("a corrupt history file is a cold read, never a crash", () => {
    const dir = repoCacheDir(HISTORY_KEY, cache());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, HISTORY_FILE), "{not json");
    expect(readRunHistory(HISTORY_KEY, cache())).toEqual([]);
    expect(() => appendRunOutcome(HISTORY_KEY, run({}), cache())).not.toThrow();
    expect(readRunHistory(HISTORY_KEY, cache())).toHaveLength(1);
  });

  it("drops entries of the wrong shape instead of crashing", () => {
    const dir = repoCacheDir(HISTORY_KEY, cache());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, HISTORY_FILE), JSON.stringify({ runs: [{ shape: 3 }, null, run({ shape: "s" })] }));
    expect(readRunHistory(HISTORY_KEY, cache()).map((r) => r.shape)).toEqual(["s"]);
  });

  it("drops an entry with an unknown verdict or owner value", () => {
    const dir = repoCacheDir(HISTORY_KEY, cache());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, HISTORY_FILE), JSON.stringify({ runs: [run({ verdict: "maybe" as never }), run({ owner: "aliens" as never }), run({ shape: "ok" })] }));
    expect(readRunHistory(HISTORY_KEY, cache()).map((r) => r.shape)).toEqual(["ok"]);
  });
});

describe("haiku floor (code-owned losses only)", () => {
  const cache = () => root;

  it("routes to sonnet when haiku lost 2 of its last 3 runs to code-owned FAILs", () => {
    appendRunOutcome(HISTORY_KEY, run({ verdict: "fail", owner: "code" }), cache());
    appendRunOutcome(HISTORY_KEY, run({ verdict: "pass" }), cache());
    appendRunOutcome(HISTORY_KEY, run({ verdict: "fail", owner: "code" }), cache());
    expect(haikuFloorExecutor(HISTORY_KEY, SHAPE, cache())).toBe("sonnet");
  });

  it("counts an escalation owned by the code as a loss", () => {
    appendRunOutcome(HISTORY_KEY, run({ verdict: "pass", owner: "code", escalated: true }), cache());
    appendRunOutcome(HISTORY_KEY, run({ verdict: "pass", owner: "code", escalated: true }), cache());
    appendRunOutcome(HISTORY_KEY, run({ verdict: "pass" }), cache());
    expect(haikuFloorExecutor(HISTORY_KEY, SHAPE, cache())).toBe("sonnet");
  });

  it("3 harness-owned FAILs do NOT trigger the floor", () => {
    appendRunOutcome(HISTORY_KEY, run({ verdict: "fail", owner: "harness" }), cache());
    appendRunOutcome(HISTORY_KEY, run({ verdict: "fail", owner: "harness" }), cache());
    appendRunOutcome(HISTORY_KEY, run({ verdict: "fail", owner: "harness" }), cache());
    expect(haikuFloorExecutor(HISTORY_KEY, SHAPE, cache())).toBe("haiku");
  });

  it("env and provider FAILs never count, nor do error or NOT PROVEN outcomes", () => {
    appendRunOutcome(HISTORY_KEY, run({ verdict: "fail", owner: "env" }), cache());
    appendRunOutcome(HISTORY_KEY, run({ verdict: "error", owner: "code" }), cache());
    appendRunOutcome(HISTORY_KEY, run({ verdict: "not_proven", owner: "code", escalated: true }), cache());
    expect(haikuFloorExecutor(HISTORY_KEY, SHAPE, cache())).toBe("haiku");
    appendRunOutcome(HISTORY_KEY, run({ verdict: "fail", owner: "provider" }), cache());
    appendRunOutcome(HISTORY_KEY, run({ verdict: "fail", owner: "provider" }), cache());
    expect(haikuFloorExecutor(HISTORY_KEY, SHAPE, cache())).toBe("haiku");
  });

  it("a FAIL with no recorded owner does not count", () => {
    appendRunOutcome(HISTORY_KEY, run({ verdict: "fail", owner: null }), cache());
    appendRunOutcome(HISTORY_KEY, run({ verdict: "fail", owner: null }), cache());
    appendRunOutcome(HISTORY_KEY, run({ verdict: "fail", owner: null }), cache());
    expect(haikuFloorExecutor(HISTORY_KEY, SHAPE, cache())).toBe("haiku");
  });

  it("keeps haiku when it lost only 1 of its last 3 runs", () => {
    appendRunOutcome(HISTORY_KEY, run({ verdict: "fail", owner: "code" }), cache());
    appendRunOutcome(HISTORY_KEY, run({ verdict: "pass" }), cache());
    appendRunOutcome(HISTORY_KEY, run({ verdict: "pass" }), cache());
    expect(haikuFloorExecutor(HISTORY_KEY, SHAPE, cache())).toBe("haiku");
  });

  it("ignores runs on other shapes and sonnet runs", () => {
    appendRunOutcome(HISTORY_KEY, run({ verdict: "fail", owner: "code" }), cache());
    appendRunOutcome(HISTORY_KEY, run({ verdict: "fail", owner: "code" }), cache());
    appendRunOutcome(HISTORY_KEY, run({ shape: "single:vitest", verdict: "fail", owner: "code" }), cache());
    appendRunOutcome(HISTORY_KEY, run({ executor: "sonnet", verdict: "fail", owner: "code" }), cache());
    expect(haikuFloorExecutor(HISTORY_KEY, SHAPE, cache())).toBe("haiku");
  });

  it("is haiku with no history or a null shape", () => {
    expect(haikuFloorExecutor(HISTORY_KEY, SHAPE, cache())).toBe("haiku");
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

  it("reads a listed sonnet shape", () => {
    const file = join(root, "defaults.json");
    writeFileSync(file, JSON.stringify({ shapes: { [SHAPE]: { executor: "sonnet", evidence: "METRICS row" } } }));
    expect(shapeDefault(SHAPE, file)).toBe("sonnet");
  });

  it("returns prior-default as a distinct value, not a model id", () => {
    const file = join(root, "defaults.json");
    writeFileSync(file, JSON.stringify({ shapes: { [SHAPE]: { executor: "prior-default", evidence: "METRICS row" } } }));
    expect(shapeDefault(SHAPE, file)).toBe("prior-default");
  });

  it("ignores any other executor value", () => {
    const file = join(root, "defaults.json");
    writeFileSync(
      file,
      JSON.stringify({
        shapes: {
          "single:none": { executor: "fable" },
          "single:vitest": { executor: "opus" },
          "single:pytest": { executor: "claude-sonnet-4-5" },
          "single:jest": { executor: "Sonnet" },
        },
      }),
    );
    expect(shapeDefault("single:none", file)).toBeNull();
    expect(shapeDefault("single:vitest", file)).toBeNull();
    expect(shapeDefault("single:pytest", file)).toBeNull();
    expect(shapeDefault("single:jest", file)).toBeNull();
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
