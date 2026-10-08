// SPEC-FIRST-INTENT: plan --spec writes an editable spec, start --spec runs against the edited file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildPlanBrief } from "../../src/engine10/stages/plan.ts";
import { buildImplementBrief } from "../../src/engine10/stages/implement.ts";
import { generateSpec, loadSpecFile, parseSpec, renderSpec, slugify, specPrLine, specReceiptBlock, SpecError, specBriefBlock } from "../../src/util/spec_file.ts";
import type { SessionResult, SessionRunner, SessionRunOptions } from "../../src/engine10/types.ts";

const here = import.meta.dir;
const golden = (n: string): string => readFileSync(join(here, "fixtures", n), "utf8");
const OK_RESULT: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0.1, killed: false };
const CRIT = { intent: "Rank search results by recency", criteria: ["ranking test passes", "no other file changes"] };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "loki-spec-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

class Fake implements SessionRunner {
  briefs: string[] = [];
  constructor(private write: (o: SessionRunOptions, brief: string) => void) {}
  async run(o: SessionRunOptions): Promise<SessionResult> { this.briefs.push(o.brief); this.write(o, o.brief); return OK_RESULT; }
}
const jsonPathOf = (brief: string): string => /exact file path: (\S+)/.exec(brief)![1]!;

describe("default behavior is unchanged", () => {
  test("plan brief golden", () => {
    expect(buildPlanBrief("add search ranking", ["src/rank.ts"], "/r/plan-output.txt", "/r/plan-scope.json")).toBe(golden("plan-brief.default.golden.txt"));
  });
  test("implement brief golden, with and without the new arg", () => {
    expect(buildImplementBrief("add search ranking", "step 1", ["tests/rank.test.ts"], "")).toBe(golden("implement-brief.default.golden.txt"));
    expect(buildImplementBrief("add search ranking", "step 1", ["tests/rank.test.ts"], "", null)).toBe(golden("implement-brief.default.golden.txt"));
  });
  test("receipt and PR blocks are empty without a spec", () => {
    expect(specReceiptBlock({})).toEqual({});
    expect(specPrLine({})).toBe("");
  });
});

describe("spec file format", () => {
  test("slugify", () => {
    expect(slugify("Add Search Ranking!! to the API")).toBe("add-search-ranking-to-the-api");
    expect(slugify("!!!")).toBe("task");
    expect(slugify("x".repeat(100)).length).toBeLessThanOrEqual(40);
  });
  test("render then parse round-trips", () => {
    const text = renderSpec("add search ranking\nsecond line", CRIT);
    const p = parseSpec(text);
    expect(p.task).toBe("add search ranking\nsecond line");
    expect(p.intent).toBe(CRIT.intent);
    expect(p.criteria).toEqual(CRIT.criteria);
  });
});

describe("malformed spec is refused with a line number", () => {
  const good = renderSpec("add search ranking", CRIT).split("\n");
  const err = (lines: string[]): SpecError => { try { parseSpec(lines.join("\n")); } catch (e) { return e as SpecError; } throw new Error("expected parseSpec to throw"); };
  test("missing marker is line 1", () => {
    const e = err(["# nothing", ...good.slice(1)]);
    expect(e).toBeInstanceOf(SpecError);
    expect(e.line).toBe(1);
  });
  test("a stray prose line in the criteria section names its line", () => {
    const i = good.findIndex((l) => l.startsWith("- "));
    const lines = [...good.slice(0, i + 1), "this is prose", ...good.slice(i + 1)];
    const e = err(lines);
    expect(e.line).toBe(i + 2);
    expect(e.message).toContain(`line ${i + 2}`);
  });
  test("empty criterion bullet names its line", () => {
    const i = good.findIndex((l) => l.startsWith("- "));
    const lines = [...good]; lines[i] = "- ";
    expect(err(lines).line).toBe(i + 1);
  });
  test("no criteria points at the section heading", () => {
    const i = good.findIndex((l) => l.startsWith("## Acceptance"));
    expect(err(good.slice(0, i + 1)).line).toBe(i + 1);
  });
  test("missing intent section", () => {
    const i = good.findIndex((l) => l.startsWith("## Intent"));
    const e = err([...good.slice(0, i), ...good.slice(i + 2)]);
    expect(e.message).toContain("Intent");
  });
  test("loadSpecFile refuses a missing file", () => {
    expect(() => loadSpecFile(join(dir, "nope.md"))).toThrow(SpecError);
  });
});

describe("generateSpec (L0: the model emits schema-checked JSON, the harness renders)", () => {
  test("writes .loki/specs/<slug>.md from the JSON", async () => {
    const s = new Fake((_o, b) => writeFileSync(jsonPathOf(b), JSON.stringify(CRIT)));
    const r = await generateSpec({ task: "add search ranking", repoDir: dir, sessions: s });
    expect(r.path).toBe(join(dir, ".loki", "specs", "add-search-ranking.md"));
    expect(parseSpec(readFileSync(r.path, "utf8")).criteria).toEqual(CRIT.criteria);
    expect(s.briefs[0]).toContain("add search ranking");
  });
  test("schema-invalid JSON is refused and nothing is written", async () => {
    const s = new Fake((_o, b) => writeFileSync(jsonPathOf(b), JSON.stringify({ intent: "x", criteria: [] })));
    await expect(generateSpec({ task: "t", repoDir: dir, sessions: s })).rejects.toThrow(/schema/);
    expect(existsSync(join(dir, ".loki", "specs", "t.md"))).toBe(false);
  });
  test("an existing spec is never overwritten without force", async () => {
    const s = new Fake((_o, b) => writeFileSync(jsonPathOf(b), JSON.stringify(CRIT)));
    await generateSpec({ task: "t", repoDir: dir, sessions: s });
    await expect(generateSpec({ task: "t", repoDir: dir, sessions: s })).rejects.toThrow(/exists/);
    await generateSpec({ task: "t", repoDir: dir, sessions: s, force: true });
  });
});

describe("round trip: plan --spec, edit one criterion, start --spec", () => {
  test("the edited criterion reaches the implement brief, the receipt sha and the PR link", async () => {
    const s = new Fake((_o, b) => writeFileSync(jsonPathOf(b), JSON.stringify(CRIT)));
    const gen = await generateSpec({ task: "add search ranking", repoDir: dir, sessions: s });
    const original = readFileSync(gen.path, "utf8");
    const edited = original.replace("- ranking test passes", "- ranking is stable under ties");
    expect(edited).not.toBe(original);
    writeFileSync(gen.path, edited, "utf8");

    const spec = loadSpecFile(gen.path);
    expect(spec.criteria).toContain("ranking is stable under ties");
    expect(spec.sha256).not.toBe(gen.sha256);
    const env = { LOKI_E10_SPEC_PATH: relative(dir, gen.path), LOKI_E10_SPEC_SHA256: spec.sha256 };

    const brief = buildImplementBrief(spec.task, "step 1", [], "", specBriefBlock(spec));
    expect(brief).toContain("ranking is stable under ties");
    expect(brief).not.toContain("- ranking test passes");
    expect(brief).toContain(spec.sha256);

    expect(specReceiptBlock(env)).toEqual({ spec: { path: ".loki/specs/add-search-ranking.md", sha256: spec.sha256 } });
    expect(specPrLine(env)).toContain(".loki/specs/add-search-ranking.md");
    expect(specPrLine(env)).toContain(spec.sha256.slice(0, 12));
  });
  test("receipt path is repo-relative even for an absolute env path", () => {
    mkdirSync(join(dir, ".loki", "specs"), { recursive: true });
    const p = join(dir, ".loki", "specs", "a.md"); writeFileSync(p, renderSpec("t", CRIT));
    const b = specReceiptBlock({ LOKI_E10_SPEC_PATH: p, LOKI_E10_SPEC_SHA256: "ab".repeat(32), LOKI_E10_REPO_DIR: dir });
    expect((b as { spec: { path: string } }).spec.path).toBe(".loki/specs/a.md");
  });
});

describe("CLI surface", () => {
  test("engine10 routes plan to plan_cmd and lists it in usage", async () => {
    const { route } = await import("../../src/engine10/cli.ts");
    expect(route(["plan", "t", "--spec"])).toEqual({ module: "plan_cmd.ts", fn: "main", args: ["t", "--spec"] });
  });
  test("plan without --spec prints usage and exits 2", async () => {
    const { main } = await import("../../src/contrib/plan_cmd.ts");
    const out: string[] = []; const w = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof process.stderr.write;
    try { expect(await main(["add", "x"])).toBe(2); } finally { process.stderr.write = w; }
    expect(out.join("")).toContain("--spec");
  });
  test("start accepts --spec and --spec-first, rejects both together", async () => {
    const { parseStartArgs } = await import("../../src/commands/start.ts");
    const quiet = (): void => {};
    expect(parseStartArgs(["--spec", ".loki/specs/a.md"], quiet, quiet)).toMatchObject({ specPath: ".loki/specs/a.md", prdPath: "" });
    expect(parseStartArgs(["add a thing", "--spec-first"], quiet, quiet)).toMatchObject({ specFirst: true, prdPath: "add a thing" });
    expect(parseStartArgs(["--spec", "f", "--spec-first"], quiet, quiet)).toBe(2);
    expect(parseStartArgs(["add a thing"], quiet, quiet)).not.toHaveProperty("specPath");
  });
  test("start --spec with a malformed spec exits 2 naming the line", async () => {
    const { main } = await import("../../src/engine10/supervisor.ts");
    const f = join(dir, "bad.md");
    writeFileSync(f, renderSpec("t", CRIT).replace("- no other file changes", "prose here"));
    const out: string[] = []; const w = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof process.stderr.write;
    try { expect(await main(["--spec", f])).toBe(2); } finally { process.stderr.write = w; }
    expect(out.join("")).toMatch(/bad\.md: line \d+:/);
  });
});

describe("implement stage reads the run snapshot", () => {
  test("the edited criterion reaches the real implement session brief", async () => {
    const { implementStage } = await import("../../src/engine10/stages/implement.ts");
    const repo = join(dir, "repo"); mkdirSync(join(repo, ".loki"), { recursive: true });
    const runDir = join(repo, ".loki", "runs", "e10-x"); mkdirSync(runDir, { recursive: true });
    const text = renderSpec("add search ranking", { intent: "Rank by recency", criteria: ["ranking is stable under ties"] });
    writeFileSync(join(runDir, "spec.snapshot.md"), text);
    const saved = process.env.LOKI_E10_SPEC_SHA256; process.env.LOKI_E10_SPEC_SHA256 = "x";
    const s = new Fake(() => {});
    try {
      await implementStage.run({
        runId: "e10-x", repoDir: repo, runDir, baseSha: "x", branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
        emit: () => {}, sessions: s, tests: { async detect() { return { runners: [], tests: [] }; }, impacted() { return []; } },
        cost: { read() { return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; } }, clock: { now: () => 0 },
        outputs: () => ({ intake: { task: "add search ranking" } }),
      } as never, new AbortController().signal);
    } finally { if (saved === undefined) delete process.env.LOKI_E10_SPEC_SHA256; else process.env.LOKI_E10_SPEC_SHA256 = saved; }
    expect(s.briefs[0]).toContain("ranking is stable under ties");
  });
});
