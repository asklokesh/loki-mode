// select: not-src-walker (reads one src file by path; readdirSync only lists a tmp cache dir)
// Tests for src/runner/router/history.ts -- H4 per-repo, per-shape outcome history, the
// Sonnet evidence floor (code-owned losses only), and the shipped shape-defaults reader.
// Pure logic plus file IO on a temp cache root; no provider is called.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  HISTORY_FILE,
  type RunOutcome,
  ACCEPTANCE_FLOOR,
  PRIOR_ACCEPTANCE,
  appendRunOutcome,
  expectedCost,
  haikuFloorExecutor,
  rankExecutorsByCost,
  routeScore,
  readRunHistory,
  shapeDefault,
  shapeKey,
  shapeKeyForRepo,
  repoHistoryFloor,
  sealedOutcomesByTier,
} from "../../src/runner/router/history.ts";
import { repoCacheDir, repoKey } from "../../src/engine10/cache.ts";
import { readOriginUrl } from "../../src/util/engine_origin.ts";
import { ranModel, recordRun } from "../../src/runner/router/cost_preview.ts";
import { receiptSha256 } from "../../src/engine10/stages/seal.ts";
import { routeRecord } from "../../src/runner/router/unit_model.ts";
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

describe("run history concurrency", () => {
  it("concurrent append keeps all", async () => {
    const N = 8;
    const src = resolve(import.meta.dir, "../../src/runner/router/history.ts");
    const script = `import { appendRunOutcome } from ${JSON.stringify(src)};
const i = Number(process.env.H_I);
const ok = appendRunOutcome(${JSON.stringify(HISTORY_KEY)}, { shape: "s", executor: "haiku", verdict: "pass", owner: null, escalated: false, usd: 0, wallS: i }, process.env.H_ROOT);
process.exit(ok ? 0 : 3);`;
    const codes = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        new Promise<number | null>((res) => {
          const c = spawn(process.execPath, ["-e", script], { stdio: "ignore", env: { ...process.env, H_I: String(i), H_ROOT: root } });
          c.on("close", res);
        }),
      ),
    );
    expect(codes).toEqual(Array(N).fill(0));
    const walls = readRunHistory(HISTORY_KEY, root).map((r) => r.wallS).sort((a, b) => a - b);
    expect(walls).toEqual(Array.from({ length: N }, (_, i) => i));
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

describe("expected accepted-outcome cost (D99 item 3, P12-32)", () => {
  const cache = () => root;
  const many = (n: number, o: Partial<RunOutcome>): RunOutcome[] => Array.from({ length: n }, () => run(o));

  it("expectedCost is price over acceptance, with a floor against divide by zero", () => {
    expect(expectedCost(1, 0.5)).toBe(2);
    expect(expectedCost(1, 0)).toBe(1 / ACCEPTANCE_FLOOR);
    expect(Number.isFinite(expectedCost(0.3, 0))).toBe(true);
  });

  it("ranking flips when the cheap route has low acceptance", () => {
    const cheapGood = [...many(3, { executor: "haiku", usd: 0.1 }), ...many(3, { executor: "sonnet", usd: 0.3 })];
    expect(rankExecutorsByCost(cheapGood, SHAPE)).toEqual(["haiku", "sonnet"]);
    const cheapBad = [
      ...many(1, { executor: "haiku", usd: 0.1 }), ...many(2, { executor: "haiku", usd: 0.1, verdict: "fail", owner: "code" }),
      ...many(3, { executor: "sonnet", usd: 0.3 }),
    ];
    expect(routeScore(cheapBad, SHAPE, "haiku")?.cost).toBeCloseTo(0.1 / (1 / 3), 10);
    expect(rankExecutorsByCost(cheapBad, SHAPE)).toEqual(["sonnet", "haiku"]);
  });

  it("uses the prior acceptance while a route has fewer than 3 counted runs", () => {
    const s = routeScore(many(2, { executor: "sonnet", usd: 0.3 }), SHAPE, "sonnet");
    expect(s).toEqual({ cost: 0.3 / PRIOR_ACCEPTANCE, acceptance: PRIOR_ACCEPTANCE, n: 2, prior: true });
    expect(routeScore(many(3, { executor: "sonnet", usd: 0.3 }), SHAPE, "sonnet")?.prior).toBe(false);
    expect(routeScore([], SHAPE, "sonnet")).toBeNull();
  });

  it("non-code outcomes do not count toward acceptance", () => {
    const runs = [...many(3, { executor: "haiku", usd: 0.1 }), ...many(5, { executor: "haiku", usd: 0.1, verdict: "fail", owner: "env" })];
    expect(routeScore(runs, SHAPE, "haiku")?.acceptance).toBe(1);
  });

  it("is deterministic for the same history", () => {
    const runs = [...many(3, { executor: "haiku", usd: 0.2 }), ...many(3, { executor: "sonnet", usd: 0.2 })];
    expect(rankExecutorsByCost(runs, SHAPE)).toEqual(rankExecutorsByCost([...runs], SHAPE));
    expect(rankExecutorsByCost(runs, SHAPE)).toEqual(["haiku", "sonnet"]);
  });

  it("haiku floor moves to sonnet when sonnet is cheaper per accepted outcome, not when it is dearer", () => {
    const put = (rs: RunOutcome[]): void => { for (const r of rs) appendRunOutcome(HISTORY_KEY, r, cache()); };
    put([run({ executor: "haiku", usd: 0.9 }), run({ executor: "haiku", usd: 0.9 }), run({ executor: "haiku", usd: 0.9 }), ...many(3, { executor: "sonnet", usd: 0.2 })]);
    expect(haikuFloorExecutor(HISTORY_KEY, SHAPE, cache())).toBe("sonnet");
  });

  it("haiku stays when it is cheaper per accepted outcome or sonnet has no history", () => {
    for (const r of [...many(3, { executor: "haiku", usd: 0.1 }), ...many(3, { executor: "sonnet", usd: 0.3 })]) appendRunOutcome(HISTORY_KEY, r, cache());
    expect(haikuFloorExecutor(HISTORY_KEY, SHAPE, cache())).toBe("haiku");
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


  it("returns haiku when the shape earned it", () => {
    const file = join(root, "earned.json");
    writeFileSync(file, JSON.stringify({ shapes: { [SHAPE]: { executor: "haiku", evidence: "METRICS row" } } }));
    expect(shapeDefault(SHAPE, file)).toBe("haiku");
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

  it("P12-32 window: old losses age out of the score", () => {
    const mk = (verdict: "pass" | "fail"): RunOutcome => ({ shape: "s", executor: "haiku", verdict, owner: verdict === "fail" ? "code" : null, escalated: false, usd: 1, wallS: 1 });
    const runs = [...Array(10).fill(0).map(() => mk("fail")), ...Array(10).fill(0).map(() => mk("pass"))];
    expect(routeScore(runs, "s", "haiku")!.acceptance).toBe(1);
  });
});

describe("P12-32b live cost routing", () => {
  const plan = { units: [{ id: "u1", kind: "k", executor: "haiku", reason: "safe" }], route_not_proven: [] };
  const seed = (dir: string, runs: RunOutcome[]) => { for (const r of runs) appendRunOutcome(repoKey(readOriginUrl(dir), dir), r, root); };
  const many = (n: number, o: Partial<RunOutcome>): RunOutcome[] => Array.from({ length: n }, () => run(o));
  const mkRepo = () => mkdtempSync(join(tmpdir(), "p1232b-repo-"));

  it("history above the floor with a lower sonnet expected cost raises the valid haiku route to sonnet", () => {
    const dir = mkRepo();
    seed(dir, [...many(1, { usd: 0.1 }), ...many(2, { usd: 0.1, verdict: "fail" }), ...many(3, { executor: "sonnet", usd: 0.3 })]);
    const floor = repoHistoryFloor(dir, root, SHAPE);
    expect(floor).toBe("sonnet");
    const rr = routeRecord("sonnet", plan, () => floor);
    expect(rr.model).toContain("sonnet");
    expect(rr.source).toBe("history");
    rmSync(dir, { recursive: true, force: true });
  });

  it("history above the floor with haiku cheaper keeps haiku", () => {
    const dir = mkRepo();
    seed(dir, [...many(3, { usd: 0.1 }), ...many(3, { executor: "sonnet", usd: 0.3 })]);
    const floor = repoHistoryFloor(dir, root, SHAPE);
    expect(floor).toBe("haiku");
    expect(routeRecord("sonnet", plan, () => floor)).toEqual(routeRecord("sonnet", plan));
    rmSync(dir, { recursive: true, force: true });
  });

  it("below the floor routing matches the no-history path exactly", () => {
    const dir = mkRepo();
    seed(dir, many(2, { verdict: "fail", usd: 0.1 }));
    const floor = repoHistoryFloor(dir, root, SHAPE);
    expect(floor).toBe("haiku");
    expect(routeRecord("sonnet", plan, () => floor)).toEqual(routeRecord("sonnet", plan));
    expect(routeRecord("sonnet", undefined, () => floor)).toEqual(routeRecord("sonnet", undefined));
    rmSync(dir, { recursive: true, force: true });
  });

  it("corrupt history falls back to today's routing", () => {
    const dir = mkRepo();
    const d = repoCacheDir(repoKey(readOriginUrl(dir), dir), root);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, HISTORY_FILE), "{not json");
    const floor = repoHistoryFloor(dir, root, SHAPE);
    expect(floor).toBe("haiku");
    expect(routeRecord("sonnet", plan, () => floor)).toEqual(routeRecord("sonnet", plan));
    rmSync(dir, { recursive: true, force: true });
  });

  it("seal-side writer: a haiku-routed run is recorded as a haiku row and the reader sees it", () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "package.json"), "{}");
    const cited = ["package.json"];
    const m: ProjectModel = { ...model("single", ["vitest"]), workspaceCite: cited, fingerprintFiles: cited, packages: [{ ...model("single", ["vitest"]).packages[0]!, cite: cited, ui: { present: false, boot: null, cite: cited } }] };
    mkdirSync(join(dir, ".loki"), { recursive: true });
    writeFileSync(join(dir, ".loki", "project.json"), JSON.stringify({ ...m, key: computeKey(dir, cited, shallowDirs(dir)) }));
    const shape = shapeKeyForRepo(dir)!;
    const env = {} as Record<string, string | undefined>;
    // ctx.model is sonnet, the routed implement model is haiku
    const haiku = ranModel({ route_model: "claude-haiku-4-5", model: "claude-haiku-4-5" }, "sonnet");
    expect(haiku).toContain("haiku");
    expect(ranModel(undefined, "sonnet")).toBe("sonnet");
    expect(ranModel({ model: "sonnet" }, "x")).toBe("sonnet");
    expect(recordRun(env, dir, haiku, "VERIFIED", 0.1, false, 5, root)).toBe(true);
    expect(recordRun(env, dir, haiku, "FAILED", 0.1, false, 5, root)).toBe(true);
    expect(recordRun(env, dir, haiku, "FAILED", 0.1, false, 5, root)).toBe(true);
    for (let i = 0; i < 3; i++) recordRun(env, dir, ranModel(undefined, "sonnet"), "VERIFIED", 0.3, false, 5, root);
    const rows = readRunHistory(repoKey(readOriginUrl(dir), dir), root);
    expect(rows.filter((r) => r.executor === "haiku" && r.shape === shape).length).toBe(3);
    expect(repoHistoryFloor(dir, root)).toBe("sonnet");
    rmSync(dir, { recursive: true, force: true });
  });

  it("a floor never lowers: a non-haiku route stays at the run floor", () => {
    expect(routeRecord("opus", undefined, () => "sonnet")).toEqual(routeRecord("opus", undefined));
  });
});

describe("sealed outcome per model tier per shape (GAME10-09a)", () => {
  const sealed = (model: string, verdict: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const body = { schema: "loki.v10.receipt/1", model, verdict, ...extra };
    return { ...body, receipt_sha256: receiptSha256(body as never), verification: { jwt: null, kid: null } };
  };
  const cheap = "claude-haiku-4-5";
  const OTHER = "single:jest";

  it("10 cheap-tier VERIFIED sealed receipts give a 10/10 record for the shape", () => {
    const rec = sealedOutcomesByTier(Array.from({ length: 10 }, (_, i) => ({ shape: SHAPE, receipt: sealed(cheap, "VERIFIED", { run: i }) })));
    expect(rec[SHAPE]?.["haiku"]).toEqual({ verified: 10, partial: 0, failed: 0, other: 0, unsealed: 0, total: 10 });
  });

  it("counts PARTIAL and FAILED separately from VERIFIED", () => {
    const rec = sealedOutcomesByTier([
      { shape: SHAPE, receipt: sealed(cheap, "VERIFIED") },
      { shape: SHAPE, receipt: sealed(cheap, "PARTIAL") },
      { shape: SHAPE, receipt: sealed(cheap, "PARTIAL", { n: 2 }) },
      { shape: SHAPE, receipt: sealed(cheap, "FAILED") },
    ]);
    expect(rec[SHAPE]?.["haiku"]).toMatchObject({ verified: 1, partial: 2, failed: 1, unsealed: 0, total: 4 });
  });

  it("a receipt with a missing, malformed or mismatched seal is not counted as VERIFIED", () => {
    const good = sealed(cheap, "VERIFIED");
    const { receipt_sha256: _h, ...missing } = good;
    const edited = { ...good, verdict: "VERIFIED", extra: "added after sealing" };
    const rec = sealedOutcomesByTier([
      { shape: SHAPE, receipt: missing },
      { shape: SHAPE, receipt: { ...good, receipt_sha256: "not-a-hash" } },
      { shape: SHAPE, receipt: edited },
      { shape: SHAPE, receipt: { ...sealed(cheap, "PARTIAL"), verdict: "VERIFIED" } },
    ]);
    expect(rec[SHAPE]?.["haiku"]).toMatchObject({ verified: 0, unsealed: 4, total: 4 });
  });

  it("two shapes and two tiers do not mix", () => {
    const rec = sealedOutcomesByTier([
      { shape: SHAPE, receipt: sealed(cheap, "VERIFIED") },
      { shape: OTHER, receipt: sealed(cheap, "FAILED") },
      { shape: SHAPE, receipt: sealed("claude-sonnet-5", "PARTIAL") },
    ]);
    expect(rec[SHAPE]?.["haiku"]).toMatchObject({ verified: 1, failed: 0, total: 1 });
    expect(rec[OTHER]?.["haiku"]).toMatchObject({ verified: 0, failed: 1, total: 1 });
    expect(rec[SHAPE]?.["sonnet"]).toMatchObject({ partial: 1, total: 1 });
  });

  it("shape names like __proto__ and constructor keep their record and never touch Object.prototype", () => {
    const rec = sealedOutcomesByTier([
      { shape: "__proto__", receipt: sealed(cheap, "VERIFIED") },
      { shape: "constructor", receipt: sealed(cheap, "VERIFIED") },
    ]);
    expect(Object.keys(Object.prototype)).toEqual([]);
    expect(({} as Record<string, unknown>)["haiku"]).toBeUndefined();
    expect(rec["__proto__"]?.["haiku"]).toMatchObject({ verified: 1, total: 1 });
    expect(rec["constructor"]?.["haiku"]).toMatchObject({ verified: 1, total: 1 });
  });

  it("an unknown or missing model gets its own unknown tier and is never a sonnet outcome", () => {
    const rec = sealedOutcomesByTier([
      { shape: SHAPE, receipt: sealed("some-other-model", "VERIFIED") },
      { shape: SHAPE, receipt: sealed(undefined as unknown as string, "VERIFIED") },
      { shape: SHAPE, receipt: sealed("claude-sonnet-5-5", "VERIFIED") },
    ]);
    expect(rec[SHAPE]?.["unknown"]).toMatchObject({ verified: 2, total: 2 });
    expect(rec[SHAPE]?.["sonnet"]).toMatchObject({ verified: 1, total: 1 });
  });
});
