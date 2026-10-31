// SPEC-FIRST-INTENT: plan --spec writes an editable spec, start --spec runs against the edited file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildPlanBrief } from "../../src/engine10/stages/plan.ts";
import { buildImplementBrief } from "../../src/engine10/stages/implement.ts";
import { clauseBriefBlock, clauseGapOf, clauseLine, coveredClauses, extractClauses, generateSpec, loadSpecFile, parseSpec, renderSpec, slugify, specPrLine, specReceiptBlock, SpecError, specBriefBlock } from "../../src/util/spec_file.ts";
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
  test("too many criteria states the real limit", () => {
    const i = good.findIndex((l) => l.startsWith("## Acceptance"));
    const e = err([...good.slice(0, i + 1), "", ...Array.from({ length: 62 }, (_, k) => `- criterion ${k}`)]);
    expect(e.message).toContain("more than 61 criteria");
    expect(e.message).not.toContain("more than 20 ");
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

describe("long task collision", () => {
  const prefix = "implement the new search ranking pipeline for the catalog ";
  test("long tasks sharing a 40 char prefix get distinct slugs, short slugs unchanged", () => {
    const a = slugify(`${prefix}using recency`), b = slugify(`${prefix}using popularity`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(40);
    expect(slugify(`${prefix}using recency`)).toBe(a);
    expect(slugify("Add Search Ranking!! to the API")).toBe("add-search-ranking-to-the-api");
    expect(slugify("a".repeat(40))).toBe("a".repeat(40));
  });
  test("generateSpec writes two different files for the two tasks", async () => {
    const s = new Fake((_o, b) => writeFileSync(jsonPathOf(b), JSON.stringify(CRIT)));
    const r1 = await generateSpec({ task: `${prefix}using recency`, repoDir: dir, sessions: s });
    const r2 = await generateSpec({ task: `${prefix}using popularity`, repoDir: dir, sessions: s });
    expect(r1.path).not.toBe(r2.path);
    expect(existsSync(r1.path) && existsSync(r2.path)).toBe(true);
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

describe("unknown flag", () => {
  const run = async (args: string[]): Promise<{ code: number; err: string }> => {
    const { main } = await import("../../src/engine10/supervisor.ts");
    const out: string[] = []; const w = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof process.stderr.write;
    try { return { code: await main(args), err: out.join("") }; } finally { process.stderr.write = w; }
  };
  test("unknown flag exits 2 with usage instead of joining the task", async () => {
    for (const f of ["--no-prr", "--dry-run", "-x", "--bogus=1"]) {
      const r = await run(["fix the bug", f]);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`unknown flag ${f}`);
      expect(r.err).toContain("usage:");
    }
  });
  test("AN-08: each exit-2 refusal in main() notes its own class for the funnel", async () => {
    const { takeRefusal } = await import("../../src/util/funnel.ts");
    const cls = async (a: string[]): Promise<string | null> => { takeRefusal(); await run(a); return takeRefusal(); };
    expect(await cls(["fix the bug", "--no-prr"])).toBe("unsupported_flag");
    expect(await cls(["task", "--provider"])).toBe("unsupported_flag");
    expect(await cls([])).toBe("prd_missing");
    expect(await cls(["--spec", join(dir, "does-not-exist.md")])).toBe("prd_missing");
    const cwd = process.cwd(), plain = mkdtempSync(join(tmpdir(), "e10-an08-")); writeFileSync(join(plain, "f"), "x");
    process.chdir(plain);
    try { expect(await cls(["do a thing"])).toBe("not_a_repo"); } finally { process.chdir(cwd); rmSync(plain, { recursive: true, force: true }); }
  });
  test("provider needs a value: missing or flag-shaped value exits 2, codex unchanged", async () => {
    for (const a of [["task", "--provider"], ["task", "--provider", "--deep"], ["task", "--provider", ""]]) {
      const r = await run(a);
      expect(r.code).toBe(2);
      expect(r.err).toContain("--provider needs a value");
    }
    const cwd = process.cwd(), plain = mkdtempSync(join(tmpdir(), "e10-pv-")); writeFileSync(join(plain, "f"), "x");
    process.chdir(plain);
    try { const r = await run(["task", "--provider", "codex"]); expect(r.err).not.toContain("needs a value"); expect(r.err).toContain("repository"); } finally { process.chdir(cwd); rmSync(plain, { recursive: true, force: true }); }
  });
  test("max-cost prefix lookalikes are unknown flags, exact and = forms still parse", async () => {
    for (const f of ["--max-costly", "--max-cost5"]) {
      const r = await run(["task", f]);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`unknown flag ${f}`);
    }
    const cwd = process.cwd(), plain = mkdtempSync(join(tmpdir(), "e10-mc-")); writeFileSync(join(plain, "f"), "x");
    process.chdir(plain);
    try { for (const a of [["task", "--max-cost", "5"], ["task", "--max-cost=5"]]) { const r = await run(a); expect(r.err).not.toContain("unknown flag"); expect(r.err).toContain("repository"); } } finally { process.chdir(cwd); rmSync(plain, { recursive: true, force: true }); }
  });
  test("-- ends options and a bullet-style task body is not a flag", async () => {
    const cwd = process.cwd(), plain = mkdtempSync(join(tmpdir(), "e10-uf-")); writeFileSync(join(plain, "f"), "x");
    process.chdir(plain); // a non-empty dir with no repo: parsing passes, then main stops at the repo check, so no run starts
    try {
      for (const a of [["--", "-weird"], ["--", "--dry-run"], ["- item one\n- item two"]]) { const r = await run(a); expect(r.err).not.toContain("unknown flag"); expect(r.err).toContain("repository"); }
    } finally { process.chdir(cwd); rmSync(plain, { recursive: true, force: true }); }
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

const PRD5 = [
  "# Search ranking", "", "Some background prose that is not a requirement.", "",
  "## Acceptance criteria", "", "- Results are ordered by recency", "- Ties break on id", "",
  "## Edge cases", "", "1. The API returns 400 for an empty query", "- [ ] Docs mention the new flag", "",
  "The service MUST NOT cache empty results. It is fast.",
].join("\n");

describe("acceptance clause extraction (generic, anchored)", () => {
  test("markdown PRD yields 5 numbered clauses with source line anchors", () => {
    const { clauses, dropped } = extractClauses(PRD5);
    expect(dropped).toBe(0);
    expect(clauses.map(clauseLine)).toEqual([
      "C1: Results are ordered by recency [l7]",
      "C2: Ties break on id [l8]",
      "C3: The API returns 400 for an empty query [l12]",
      "C4: Docs mention the new flag [l13]",
      "C5: The service MUST NOT cache empty results. [l15]",
    ]);
  });
  test("DOCX-extracted text with form-feed pages anchors page and line", () => {
    const { clauses } = extractClauses("Intro\n\fThe system SHALL log every login.\nOther text.\n");
    expect(clauses.map(clauseLine)).toEqual(["C1: The system SHALL log every login. [p2:l1]"]);
  });
  test("issue template boilerplate is not a clause; Given/When/Then is one clause; acceptance checklists stay", () => {
    const body = ["## Preflight checklist", "- [ ] I have searched existing issues", "", "## Acceptance", "- [ ] I have read the docs and it works", "", "Given a user", "When they log in", "Then a token is issued"].join("\n");
    const t = extractClauses(body).clauses.map((c) => c.text);
    expect(t).toEqual(["I have read the docs and it works", "Given a user When they log in Then a token is issued"]);
  });
  test("fenced code is ignored", () => {
    expect(extractClauses("```\n1. not a clause\n```\n").clauses).toEqual([]);
  });
  test("same text gives same ids; editing one clause changes only its text_sha256", () => {
    const a = extractClauses(PRD5).clauses, b = extractClauses(PRD5).clauses;
    expect(b).toEqual(a);
    const c = extractClauses(PRD5.replace("Ties break on id", "Ties break on name")).clauses;
    expect(c.map((x) => x.id)).toEqual(a.map((x) => x.id));
    expect(c.map((x, i) => x.text_sha256 !== a[i]!.text_sha256)).toEqual([false, true, false, false, false]);
  });
  test("duplicates collapse; over 40 keeps 40 and reports the dropped count", () => {
    expect(extractClauses("1. Same thing\n2. same   thing\n").clauses).toHaveLength(1);
    const many = Array.from({ length: 45 }, (_, i) => `${i + 1}. requirement number ${i}`).join("\n");
    const r = extractClauses(many);
    expect([r.clauses.length, r.dropped]).toEqual([40, 5]);
  });
  test("no recognizable clause: empty set, brief block empty, locked spec unchanged", () => {
    const r = extractClauses("Just some prose.\nNothing here.");
    expect(r.clauses).toEqual([]);
    expect(clauseBriefBlock(r)).toEqual([]);
    expect(renderSpec("t", CRIT, r)).toBe(renderSpec("t", CRIT));
  });
  test("RFC 2119 rule is load-bearing: a MUST sentence outside any list is a clause", () => {
    expect(extractClauses("Plain text. The tool MUST exit 2 on error.").clauses.map((c) => c.text)).toEqual(["The tool MUST exit 2 on error."]);
  });
  test("FALSEVER-CLAUSE recall: a bullet under any heading is a clause; scope-exclusion headings are not", () => {
    const t = extractClauses(["## Errors", "- Syntax reports the offset", "- Arity names the function", "", "## Non-goals", "- GUI support", "", "## Notes:", "1. Be nice", "", "## Acceptance examples", "- 2+2 is 4", "", "## Out of scope", "- plugins"].join("\n")).clauses.map((c) => c.text);
    expect(t).toEqual(["Syntax reports the offset", "Arity names the function", "2+2 is 4"]);
  });
  test("FALSEVER-CLAUSE recall: OpenAPI YAML yields one clause per operation and per status code its text names", () => {
    const yaml = ["openapi: 3.0.3", "info:", "  title: T", "paths:", "  /links:", "    post:", "      description: |", "        Bad body: 400. Success: 201 `{}`.", "  /links/{code}:", "    get:", "      description: Unknown code: 404.", "    delete:", "      description: 204 empty."].join("\n");
    expect(extractClauses(yaml).clauses.map((c) => c.text)).toEqual(["operation POST /links", "POST /links returns 400", "POST /links returns 201", "operation GET /links/{code}", "GET /links/{code} returns 404", "operation DELETE /links/{code}", "DELETE /links/{code} returns 204"]);
  });
  test("FALSEVER-CLAUSE coverage: a marker counts only with an assertion token near it, in any language", () => {
    const go = "// clause: C1\nif got != want {\n  t.Errorf(\"bad\")\n}\n", rs = "// clause: C2\nassert_eq!(eval(\"1/0\"), Err(DivisionByZero));\n", py = "# clause: C3\nwith pytest.raises(ValueError):\n    f()\n", sh = "# clause: C4\n[ \"$status\" -eq 2 ]\n", java = "// clause: C5\nassertThrows(X.class, () -> f());\n";
    expect([...coveredClauses([go, rs, py, sh, java])].sort()).toEqual(["C1", "C2", "C3", "C4", "C5"]);
    expect([...coveredClauses(["// clause: C1\n// assert this later\nconst x = 1;\n"])]).toEqual([]);
    expect([...coveredClauses(["// clause: C1\n" + "\n".repeat(20) + "expect(1).toBe(1);\n"])]).toEqual([]);
    const set = extractClauses("- one\n- two\n- three\n");
    expect(clauseGapOf(set, [go])).toEqual(["spec clause not covered: C2: two", "spec clause not covered: C3: three"]);
    expect(clauseGapOf(extractClauses("Plain prose only."), [])).toEqual([]);
  });
  test("locked spec carries the 5 clauses and round-trips through parseSpec", () => {
    const text = renderSpec("t", CRIT, extractClauses(PRD5));
    expect(parseSpec(text).criteria.filter((x) => /^C\d: .* \[l\d+\]$/.test(x))).toHaveLength(5);
  });
  test("generateSpec writes the clauses extracted from the task", async () => {
    const f = new Fake((o) => writeFileSync(jsonPathOf(o.brief), JSON.stringify(CRIT)));
    const g = await generateSpec({ task: PRD5, repoDir: dir, sessions: f });
    expect(loadSpecFile(g.path).criteria.filter((x) => /^C\d: /.test(x))).toHaveLength(5);
  });
});
