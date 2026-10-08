// select: walk-all-src
// loki-ts/tests/project_model/project_model.test.ts -- EL-W1-01 wall checks (L0, L4). The model call is
// a mocked SessionRunner replaying recorded answers; no real model is called.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectApi } from "../../src/project_model/api.ts";
import { discoverProjectModel, loadCached, PROJECT_FILE } from "../../src/project_model/discover.ts";
import { GATHER_CAPS, gather } from "../../src/project_model/gather.ts";
import { validateAnswer } from "../../src/project_model/schema.ts";
import { runIntake } from "../../src/engine10/stages/intake.ts";
import type { RunContext, SessionResult, SessionRunOptions } from "../../src/engine10/types.ts";

const FIX = join(import.meta.dir, "..", "fixtures", "project-model", "firelater-17");
const RECORDED = JSON.parse(readFileSync(join(FIX, "response.json"), "utf8")) as Record<string, any>;
const dirs: string[] = [];

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "pm-test-"));
  dirs.push(d);
  cpSync(FIX, d, { recursive: true });
  rmSync(join(d, "response.json"));
  execFileSync("git", ["init", "-q"], { cwd: d, stdio: "pipe", env: process.env });
  execFileSync("git", ["add", "-A", "-f"], { cwd: d, stdio: "pipe", env: process.env });
  return d;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** Replays `answers` one per session: each is written to the answer file named in the brief. */
function mock(answers: unknown[]): { runner: { run(o: SessionRunOptions): Promise<SessionResult> }; briefs: string[] } {
  const briefs: string[] = [];
  return {
    briefs,
    runner: {
      async run(o) {
        briefs.push(o.brief);
        const a = answers[Math.min(briefs.length - 1, answers.length - 1)];
        const path = /\(absolute path\): (\S+)/.exec(o.brief)![1]!;
        writeFileSync(path, JSON.stringify(a));
        return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false };
      },
    },
  };
}
function ctxFor(repoDir: string, runner: unknown): RunContext {
  return { runId: "r1", repoDir, runDir: join(repoDir, ".loki", "runs", "r1"), sessions: runner } as unknown as RunContext;
}
const clone = (): Record<string, any> => JSON.parse(JSON.stringify(RECORDED));
const sig = new AbortController().signal;

describe("schema", () => {
  test("rejects an answer with no citation", () => {
    const d = repo();
    const a = clone();
    a.packages[0].commands.test.cite = [];
    const r = validateAnswer(d, a);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join("\n")).toContain("packages[0].commands.test.cite: needs at least one citation");
  });
  test("rejects a citation to a missing file", () => {
    const d = repo();
    const a = clone();
    a.packages[1].cite = ["frontend/not-here.json"];
    const r = validateAnswer(d, a);
    expect(!r.ok && r.errors.join("\n")).toContain("does not exist");
  });
  test("rejects a path escaping the repo and a missing package root", () => {
    const d = repo();
    const a = clone();
    a.workspaceCite = ["../outside.md"];
    a.packages[0].root = "nope";
    const r = validateAnswer(d, a);
    expect(!r.ok && r.errors.join("\n")).toContain("not a repo-relative path");
    expect(!r.ok && r.errors.join("\n")).toContain('directory "nope" does not exist');
  });
  test("accepts the recorded answer and a path:line citation", () => {
    const d = repo();
    const a = clone();
    a.packages[0].cite = ["backend/package.json:1-2"];
    expect(validateAnswer(d, a).ok).toBe(true);
  });
});

describe("discovery", () => {
  test("recorded FireLater answer yields backend/ and frontend/ roots with cited commands", async () => {
    const d = repo();
    const m = mock([RECORDED]);
    const out = await discoverProjectModel(ctxFor(d, m.runner), sig);
    expect(out.cached).toBe(false);
    const api = projectApi(out.model);
    expect(api.known()).toBe(true);
    expect(api.packages().map((p) => p.root).sort()).toEqual(["backend", "frontend"]);
    expect(api.packageRootOf("backend/tests/unit/validation.test.ts")).toBe("backend");
    expect(api.relativeToRoot("backend/tests/unit/validation.test.ts")).toBe("tests/unit/validation.test.ts");
    expect(api.packageRootOf("README.md")).toBeNull();
    const t = api.commandFor("backend", "test")!;
    expect(t.cwd).toBe("backend");
    expect(t.cite).toContain("backend/package.json");
    expect(api.commandFor("frontend", "start")).toBeNull();
    expect(api.hasUI()).toBe(true);
    expect(api.uiBoot()!.pkg.root).toBe("frontend");
    expect(existsSync(join(d, PROJECT_FILE))).toBe(true);
    expect(m.briefs[0]).toContain('<file path="backend/package.json">');
  });

  test("one retry carries the errors, then a good answer is accepted", async () => {
    const d = repo();
    const bad = clone();
    bad.packages[0].commands.test.cite = [];
    const m = mock([bad, RECORDED]);
    const out = await discoverProjectModel(ctxFor(d, m.runner), sig);
    expect(out.attempts).toBe(2);
    expect(out.model.status).toBe("ok");
    expect(m.briefs[1]).toContain("REJECTED");
    expect(m.briefs[1]).toContain("needs at least one citation");
  });

  test("two rejections end as a typed unknown model, never invented, never cached", async () => {
    const d = repo();
    const bad = clone();
    bad.packages[0].cite = ["missing.json"];
    const m = mock([bad, bad, RECORDED]);
    const out = await discoverProjectModel(ctxFor(d, m.runner), sig);
    expect(m.briefs.length).toBe(2);
    expect(out.model.status).toBe("unknown");
    expect(out.model.packages).toEqual([]);
    expect(out.model.reason).toContain("rejected twice");
    expect(out.owner).toBe("model");
    const api = projectApi(out.model);
    expect(api.known()).toBe(false);
    expect(api.packageRootOf("backend/x.test.ts")).toBeNull();
    expect(api.hasUI()).toBe(false);
  });

  test("cache hit when hashes are unchanged, miss after a lockfile edit", async () => {
    const d = repo();
    const m = mock([RECORDED]);
    const first = await discoverProjectModel(ctxFor(d, m.runner), sig);
    expect(first.cached).toBe(false);
    const second = await discoverProjectModel(ctxFor(d, m.runner), sig);
    expect(second.cached).toBe(true);
    expect(second.attempts).toBe(0);
    expect(second.model.key).toBe(first.model.key);
    expect(m.briefs.length).toBe(1);
    writeFileSync(join(d, "backend", "package-lock.json"), '{ "lockfileVersion": 3, "note": "edited" }\n');
    const third = await discoverProjectModel(ctxFor(d, m.runner), sig);
    expect(third.cached).toBe(false);
    expect(m.briefs.length).toBe(2);
    expect(third.model.key).not.toBe(first.model.key);
    expect(loadCached(d)!.key).toBe(third.model.key);
  });

  test("a new directory (a new package) also misses the cache", async () => {
    const d = repo();
    const m = mock([RECORDED]);
    await discoverProjectModel(ctxFor(d, m.runner), sig);
    cpSync(join(d, "frontend"), join(d, "admin"), { recursive: true });
    // stage only the new package: force-adding .loki/project.json would make it the committed shared model (B5)
    execFileSync("git", ["add", "-A", "-f", "--", "admin"], { cwd: d, stdio: "pipe", env: process.env });
    expect((await discoverProjectModel(ctxFor(d, m.runner), sig)).cached).toBe(false);
  });
});

describe("intake wiring", () => {
  test("intake records the model key and cache state in stage data; the knob turns it off", async () => {
    const d = repo();
    for (const a of [["config", "user.email", "t@example.com"], ["config", "user.name", "t"], ["commit", "-q", "-m", "init"]]) execFileSync("git", a, { cwd: d, stdio: "pipe", env: process.env });
    const m = mock([RECORDED]);
    const ctx = { ...ctxFor(d, m.runner), branch: "loki/pm-test", tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] } } as unknown as RunContext;
    const prev = process.env["LOKI_E10_PROJECT_MODEL"];
    try {
      delete process.env["LOKI_E10_PROJECT_MODEL"]; // FC-01: default ON
      const r = await runIntake(ctx, sig, { taskText: "do a thing" });
      const pm = (r.data as any).project_model;
      expect(pm.status).toBe("ok");
      expect(pm.cached).toBe(false);
      expect(pm.key).toBe(loadCached(d)!.key);
      expect(((await runIntake(ctx, sig, { taskText: "do a thing" })).data as any).project_model.cached).toBe(true);
      process.env["LOKI_E10_PROJECT_MODEL"] = "0"; // the opt-out
      const before = m.briefs.length;
      expect((await runIntake(ctx, sig, { taskText: "do a thing" })).data).not.toHaveProperty("project_model");
      expect(m.briefs.length).toBe(before);
    } finally { if (prev === undefined) delete process.env["LOKI_E10_PROJECT_MODEL"]; else process.env["LOKI_E10_PROJECT_MODEL"] = prev; }
  });
});

describe("gather caps", () => {
  test("is bounded by file count, total bytes and depth", () => {
    const d = repo();
    for (let i = 0; i < 100; i++) writeFileSync(join(d, `f${i}.txt`), "x".repeat(2000));
    mkdirDeep(d);
    execFileSync("git", ["add", "-A", "-f"], { cwd: d, stdio: "pipe", env: process.env });
    const g = gather(d);
    expect(g.files.length).toBeLessThanOrEqual(GATHER_CAPS.maxFiles);
    expect(g.files.reduce((n, f) => n + f.text.length, 0)).toBeLessThanOrEqual(GATHER_CAPS.maxTotalBytes);
    expect(g.tree.every((p) => p.split("/").length <= GATHER_CAPS.maxDepth)).toBe(true);
    expect(g.tree.length).toBeLessThanOrEqual(GATHER_CAPS.maxTreeLines);
  });
});
function mkdirDeep(d: string): void {
  execFileSync("mkdir", ["-p", join(d, "a", "b", "c", "d")], { env: process.env });
  writeFileSync(join(d, "a", "b", "c", "d", "deep.txt"), "deep");
}

describe("L0 self-check", () => {
  test("new project_model sources name no language or framework in code", () => {
    const root = join(import.meta.dir, "..", "..", "src", "project_model");
    const NAMES = /\b(npm|pnpm|yarn|bun|vitest|jest|pytest|cargo|golang|python|typescript|javascript|react|vue|svelte|django|flask|rails|maven|gradle|composer|gemfile|pom\.xml|package\.json|pyproject|go\.mod|cargo\.toml|node_modules)\b/i;
    const files = readdirSync(root).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const code = readFileSync(join(root, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/ .*$/, ""));
      for (const l of code) expect(`${f}: ${NAMES.test(l) ? l : ""}`).toBe(`${f}: `);
    }
    const intake = readFileSync(join(import.meta.dir, "..", "..", "src", "engine10", "stages", "intake.ts"), "utf8");
    expect(intake).not.toMatch(/project_model[^\n]*(npm|vitest|jest|pytest)/i);
  });
});
