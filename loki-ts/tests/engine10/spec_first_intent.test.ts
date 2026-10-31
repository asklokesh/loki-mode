// SPEC-FIRST-INTENT: plan --spec writes an editable spec, start --spec runs against the edited file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildPlanBrief } from "../../src/engine10/stages/plan.ts";
import { buildImplementBrief } from "../../src/engine10/stages/implement.ts";
import { clauseBriefBlock, clauseDroppedNote, clauseGapOf, clauseLine, coveredClauses, extractClauses, generateSpec, loadSpecFile, parseSpec, renderSpec, slugify, specPrLine, specReceiptBlock, SpecError, specBriefBlock, weakAssertionNote } from "../../src/util/spec_file.ts";
import { verdictOf } from "../../src/engine10/stages/seal.ts";
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
  "## Notes", "", "1. The API returns 400 for an empty query", "- [ ] Docs mention the new flag", "",
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
    const t = extractClauses(["## Errors", "- Syntax reports the offset", "- Arity names the function", "", "## Non-goals", "- GUI support", "", "## Notes:", "1. Be nice", "", "## Examples", "- 1+2*3 gives 7", "", "## Out of scope", "- plugins", "", "## Will not do", "- macros"].join("\n")).clauses.map((c) => c.text);
    expect(t).toEqual(["Syntax reports the offset", "Arity names the function", "Be nice", "1+2*3 gives 7"]);
  });
  test("a skip heading is the whole heading title: Will not crash, Future-dated payments and Future-proofing keep their bullets", () => {
    const t = extractClauses(["## Will not crash", "- Bad input exits 2", "", "## Future-dated payments", "- Dates in the past are rejected", "", "## Future-proofing", "- Unknown keys are ignored", "", "## Out of scope for the tool", "- plugins"].join("\n")).clauses.map((c) => c.text);
    expect(t).toEqual(["Bad input exits 2", "Dates in the past are rejected", "Unknown keys are ignored", "plugins"]);
  });
  test("background style headings (References, Alternatives, Glossary, Context, Rationale, Motivation, Appendix, Background) yield no clauses, with numbering, bold or a colon", () => {
    const heads = ["## References", "## Alternatives", "## Glossary", "## Context", "## Rationale:", "## 3. Motivation", "### Appendix (informative)", "# **Background**", "## Future work", "## Non-goals", "## Won't do", "Out of scope:"];
    for (const h of heads) expect(extractClauses([h, "- Something that reads like a bullet", ""].join("\n")).clauses.map((c) => c.text)).toEqual([]);
  });
  test("alternatives headings with a qualifier yield no clauses", () => {
    for (const h of ["## Alternatives considered", "## Alternatives explored", "## Alternatives rejected", "## Considered alternatives", "### 2. Alternatives Considered:"]) {
      expect(extractClauses([h, "- Use bit.ly (rejected: cost)"].join("\n")).clauses.map((c) => c.text)).toEqual([]);
    }
    expect(extractClauses("## Alternatives to cache\n- Entries expire after 5 minutes").clauses).toHaveLength(1);
  });
  test("Context and Background headings keep their requirement text and bullets; only exclusion titles take Title: text", () => {
    expect(extractClauses("## Context: Billing\n- An invoice total equals the sum of its lines").clauses).toHaveLength(1);
    expect(extractClauses("## Background: refunds should settle within 2 days\n- A refund older than 2 days is marked late").clauses.map((c) => c.text)).toEqual(["Background: refunds should settle within 2 days", "A refund older than 2 days is marked late"]); // a modal heading stays a clause over a list
    expect(extractClauses("## Background: refunds should settle within 2 days\n\n## Notes\n").clauses.map((c) => c.text)).toEqual(["Background: refunds should settle within 2 days"]); // a leaf keeps it
    expect(extractClauses("## Out of scope: anything about OAuth").clauses).toEqual([]);
  });
  test("a 14-section PRD with bullets only under real sections gives 14 clauses, skip sections add none", () => {
    const secs: string[] = [];
    for (let i = 1; i <= 14; i++) secs.push(`## Behavior ${i}`, `- Rule ${i} holds`, "");
    secs.push("## References", "- RFC 1", "", "## Glossary", "- term", "", "## Alternatives", "- other");
    expect(extractClauses(secs.join("\n")).clauses.length).toBe(14);
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

// WALL-ASSERT-STRENGTH: a disclosure of assertions that only prove an error happened; never a verdict input
describe("weakAssertionNote", () => {
  const note = (rel: string, body: string): string | null => weakAssertionNote([{ rel, body }]);
  const wall = (n: string): string => readFileSync(join(here, "fixtures", "wall", n), "utf8");
  test("replay of the rejected rust-expr-prd Wall surfaces the bare max() is_err line", () => {
    const n = note("tests/loki_wall_calc.rs", wall("rust_expr_rejected.rs"));
    expect(n).toBe(NOTE(3, "tests/loki_wall_calc.rs:22,23,107"));
    expect(wall("rust_expr_rejected.rs").split("\n")[106]).toContain('eval("max()"');
  });
  test("an accepted Wall with exact Err(Arity(..)) asserts shows no line", () => {
    expect(note("tests/loki_wall_calc.rs", wall("rust_expr_exact.rs"))).toBeNull();
  });
  const NOTE = (n: number, at: string): string => `Wall assertion strength not measured: ${n} error assertion(s) do not name the expected error on the same line or the 3 lines after (${at}); the Wall is model-authored`;
  const rows: [string, string, string][] = [
    ["rust", "assert!(f(1).is_err());", "assert_eq!(f(1), Err(E::Arity));"],
    ["rust with a message", 'assert!(f(1).is_err(), "arity");', "assert_eq!(f(1), Err(E::Arity));"],
    ["rust debug_assert", "debug_assert!(f(1).is_err());", "assert_eq!(f(1), Err(E::Arity));"],
    ["python", "with pytest.raises(Exception):\n    f()", "with pytest.raises(ValueError):\n    f()"],
    ["python unittest", "self.assertRaises(Exception, f)", "self.assertRaises(KeyError, f)"],
    ["js", "expect(() => f()).toThrow();", 'expect(() => f()).toThrow("bad input");'],
    ["js rejects", "await expect(p).rejects.toThrow();", "await expect(p).rejects.toThrow(RangeError);"],
    ["chai", "expect(f).to.throw();", "expect(f).to.throw(RangeError);"],
    ["node:test throws", "assert.throws(() => f(1));", "assert.throws(() => f(1), /bad input/);"],
    ["node:test rejects", "await assert.rejects(p);", "await assert.rejects(p, { name: 'RangeError' });"],
    ["go", "if err == nil {\n  t.Fatal(\"x\")\n}", "if !errors.Is(err, ErrArity) {\n  t.Fatal(\"x\")\n}"],
    ["go testify", "assert.Error(t, err)", "assert.ErrorIs(t, err, ErrArity)"],
    ["go require with a message", 'require.Error(t, err, "arity")', "require.EqualError(t, err, \"arity\")"],
    ["rust Err( on the next line", "assert!(r.is_err());", "assert!(r.is_err());\nassert_eq!(r, Err(E::Arity));"],
    ["rust matches!", "assert!(r.is_err());", "assert!(r.is_err());\nassert!(matches!(kind, E::Arity));"],
    ["go err != sentinel", "if err == nil {\n  t.Fatal(\"x\")\n}", "if err == nil {\n  t.Fatal(\"x\")\n}\nif err != ErrArity {\n  t.Fatal(\"y\")\n}"],
    ["go err != Err-prefixed", "if err == nil {\n  t.Fatal(\"x\")\n}", "if err == nil {\n  t.Fatal(\"x\")\n}\nif err != ArityErr {\n  t.Fatal(\"y\")\n}"],
    ["go Error() comparison", "if err == nil {\n  t.Fatal(\"x\")\n}", "if err == nil {\n  t.Fatal(\"x\")\n}\nif err.Error() != \"arity\" {\n  t.Fatal(\"y\")\n}"],
    ["python exception value", "with pytest.raises(Exception) as e:\n    f()", "with pytest.raises(Exception) as e:\n    f()\nassert \"arity\" in str(e.value)"],
    ["js error message", "expect(() => f()).toThrow();", "expect(() => f()).toThrow();\nexpect(e.message).toBe(\"arity\");"],
    ["bats status", '[ "$status" -ne 0 ]', '[ "$status" -eq 2 ]'],
    ["bats assert_failure", "assert_failure", "assert_failure 2"],
    ["bats run !", "run ! tool --bad", 'run tool --bad\n  [ "$status" -eq 2 ]'],
  ];
  for (const [name, weak, strong] of rows) {
    test(`${name}: a bare error check is listed with the exact note, a pinned one is not`, () => {
      expect(note("w", `// clause: C1\n${weak}\n`)).toBe(NOTE(1, "w:2"));
      expect(note("w", `// clause: C1\n${strong}\n`)).toBeNull();
    });
  }
  test("a Go if err == nil whose body compares values is the success branch, not an error check", () => {
    expect(note("w", "if err == nil {\n  if got != want {\n    t.Fatal(\"x\")\n  }\n}\n")).toBeNull();
    expect(note("w", "if err == nil { if got != want { t.Fatal(\"x\") } }\n")).toBeNull();
    expect(note("w", "if err == nil { t.Fatal(\"x\") }\n")).toBe(NOTE(1, "w:1"));
  });
  test("a pinning token on the next 3 lines of the same block suppresses the note; the 4th line or the next test does not", () => {
    expect(note("w", 'if err == nil {\n  t.Fatal("x")\n}\nif !errors.Is(err, ErrArity) {\n}\n')).toBeNull();
    expect(note("w", "assert!(f().is_err());\nlet e = f().unwrap_err();\n")).toBeNull();
    expect(note("w", "assert.Error(t, err)\nassert.ErrorIs(t, err, ErrX)\n")).toBeNull();
    expect(note("w", "require.Error(t, err)\nrequire.EqualError(t, err, \"x\")\n")).toBeNull();
    expect(note("w", "require.Error(t, err)\nrequire.ErrorContains(t, err, \"x\")\n")).toBeNull();
    expect(note("w", "assert!(f().is_err());\n\n\n\nlet e = f().unwrap_err();\n")).toBe(NOTE(1, "w:1"));
    expect(note("w", "assert!(f().is_err());\n#[test]\nfn b() { let e = f().unwrap_err(); }\n")).toBe(NOTE(1, "w:1"));
    expect(note("w", "run tool\nassert_failure\nassert_output --partial 'bad'\n")).toBeNull();
    expect(note("w", 'run tool\n[ "$status" -ne 0 ]\n[[ "$output" == *bad* ]]\n')).toBeNull();
    expect(note("w", "with pytest.raises(Exception) as excinfo:\n    f()\n")).toBeNull();
    expect(note("w", "with self.assertRaises(Exception) as cm:\n    f()\nself.assertIn('x', str(cm.exception))\n")).toBeNull();
  });
  test("raises(Exception, match=...), a negated !x.is_err(), and is_none() are not error checks to disclose", () => {
    expect(note("w", 'with pytest.raises(Exception, match="bad"):\n    f()\n')).toBeNull();
    expect(note("w", "assert!(!f(1).is_err());\n")).toBeNull();
    expect(note("w", "assert!(g().is_none());\n")).toBeNull();
  });
  test("node:test assert.throws that closes on its line with a second argument is not counted; one that spans lines is not guessed at", () => {
    expect(note("w", "assert.throws(fn, { message: 'x' });\n")).toBeNull();
    expect(note("w", "assert.throws(() => {\n  f();\n}, /x/);\n")).toBeNull();
  });
  test("a commented-out weak check is not counted", () => {
    expect(note("w", "// assert!(f().is_err());\n# [ \"$status\" -ne 0 ]\n")).toBeNull();
  });
});

// CLAUSE-HEADING: requirement text written on a heading line is a clause; a bare section title is not
describe("heading lines that state a requirement", () => {
  const texts = (s: string): string[] => extractClauses(s).clauses.map((c) => c.text);
  const ERR_HEAD = "## Errors (`EvalError`, a public enum implementing `std::error::Error` and `PartialEq`)";
  test("the rust-expr-prd Errors heading is a container over its bullets, and a clause as a leaf", () => {
    expect(texts([ERR_HEAD, "- `EvalError::Arity(String)`: wrong argument count"].join("\n"))).toEqual(["`EvalError::Arity(String)`: wrong argument count"]);
    expect(texts([ERR_HEAD, "", "## Other"].join("\n"))).toEqual([ERR_HEAD.slice(3)]);
  });
  test("a modal requirement heading stays a clause with bullets or a numbered list under it", () => {
    expect(texts("## The parser must reject empty input\n\n1. Empty string\n2. Only spaces")).toEqual(["The parser must reject empty input", "Empty string", "Only spaces"]);
    expect(texts("## The API must return 401 when the token is missing\n- The body names the header")).toEqual(["The API must return 401 when the token is missing", "The body names the header"]);
    expect(texts("## The API will return 401 when the token is missing\n- The body names the header")).toHaveLength(2);
    expect(texts("## Will not crash\n- Bad input exits 2")).toEqual(["Bad input exits 2"]);
  });
  test("a standard-reference heading keeps a colon requirement sentence; a bare or title-only one is no clause", () => {
    expect(texts("## RFC 4180: fields containing a comma are wrapped in double quotes.")).toEqual(["RFC 4180: fields containing a comma are wrapped in double quotes."]);
    expect(texts("## ISO 8601: dates must be written as YYYY-MM-DD.")).toHaveLength(1);
    expect(texts("## RFC 4180")).toEqual([]);
    expect(texts("## Overview")).toEqual([]);
    expect(texts("## Will it scale?")).toEqual([]);
  });
  test("a numbered or blank-separated list under a non-modal heading makes it a container; prose does not", () => {
    expect(texts("## Output should be sorted\nIt returns an error.\n\n## Next")).toEqual(["Output should be sorted"]);
  });
  test("an RFC-style title heading is not a clause, a bare Approach: over bullets leaves the bullets, a leaf Approach: sentence is a clause", () => {
    expect(texts("# RFC 4180: Common Format and MIME Type for CSV Files.")).toEqual([]);
    expect(texts("# Common Format and MIME Type for Comma-Separated Values (CSV) Files")).toEqual([]);
    expect(texts("Approach:\n- Parse lazily\n- Emit tokens in order")).toEqual(["Parse lazily", "Emit tokens in order"]);
    expect(texts("## Approach: the parser reads the whole input first.\n- Parse lazily\n- Emit tokens in order")).toEqual(["Parse lazily", "Emit tokens in order"]);
    expect(texts("## Approach: the parser reads the whole input first.\n\n## Next")).toEqual(["Approach: the parser reads the whole input first."]);
  });
  test("when, where and if lines are questions only with a trailing question mark", () => {
    expect(texts("## When the token is missing, the API must return 401")).toEqual(["When the token is missing, the API must return 401"]);
    expect(texts("## Where the file is absent, the tool should exit 2")).toHaveLength(1);
    expect(texts("## If the cache is cold the service should warm it")).toHaveLength(1);
    expect(texts("## When should it retry?")).toEqual([]);
    expect(texts("## Where should the file live?")).toEqual([]);
    expect(texts("## If the token is missing, should the API return 401?")).toEqual([]);
  });
  // The cap goes through the real verdictOf with the gap clauseGapOf computes from the spec and the sealed Wall bodies.
  const verdictFor = (spec: string, wall: string): string => {
    const gap = clauseGapOf(extractClauses(spec), [wall]);
    const pass = { name: "vitest:a", cmd: "x", result: "pass" as const, duration_s: 1 };
    return verdictOf({ implement: { exit: "done" }, intake: {} } as never, [pass], false, false, false, true, false, [], [], [], gap);
  };
  test("verdictOf: an unproven heading clause caps VERIFIED at PARTIAL, a proven one does not", () => {
    const spec = "## When the token is missing, the API must return 401\n\n## Other\n- It logs the request";
    expect(extractClauses(spec).clauses.map((c) => c.id)).toEqual(["C1", "C2"]);
    expect(verdictFor(spec, "// clause: C2\nexpect(log).toBe(1);\n")).toBe("PARTIAL");
    expect(verdictFor(spec, "// clause: C1\nexpect(status).toBe(401);\n// clause: C2\nexpect(log).toBe(1);\n")).toBe("VERIFIED");
  });
  test("verdictOf: a dropped-before requirement heading now caps at PARTIAL when unproven, and a fully covered spec stays VERIFIED", () => {
    const spec = "## The API must return 401 when the token is missing\n- The body names the header\n\n## RFC 4180: fields containing a comma are wrapped in double quotes.\n";
    expect(extractClauses(spec).clauses.map((c) => c.id)).toEqual(["C1", "C2", "C3"]);
    expect(verdictFor(spec, "// clause: C2\nassert!(a);\n// clause: C3\nassert!(b);\n")).toBe("PARTIAL"); // C1 unproven
    expect(verdictFor(spec, "// clause: C1\nassert!(a);\n// clause: C2\nassert!(b);\n")).toBe("PARTIAL"); // C3 unproven
    expect(verdictFor(spec, "// clause: C1\nassert!(a);\n// clause: C2\nassert!(b);\n// clause: C3\nassert!(c);\n")).toBe("VERIFIED"); // control: no inflation
  });
  test("verdictOf: a heading over bullets adds no heading clause, so proving the bullets is enough", () => {
    const spec = "## Errors (`EvalError`, a public enum implementing `std::error::Error`)\n- Arity is reported\n- Syntax is reported";
    expect(verdictFor(spec, "// clause: C1\nassert!(a);\n// clause: C2\nassert!(b);\n")).toBe("VERIFIED");
    expect(verdictFor(spec, "// clause: C1\nassert!(a);\n")).toBe("PARTIAL");
  });
  test("must/should/shall verb alone makes a heading clause", () => {
    expect(texts("## The parser must reject empty input")).toHaveLength(1);
    expect(texts("## Output should be sorted")).toHaveLength(1);
    expect(texts("## Callers shall retry")).toHaveLength(1);
  });
  test("implements alone makes a heading clause", () => {
    expect(texts("## The error type implements Display")).toHaveLength(1);
  });
  test("a colon then a full sentence makes a heading clause", () => {
    expect(texts("## Errors: every variant carries a message.")).toHaveLength(1);
  });
  test("bare titles yield none in markdown, setext and numbered headings", () => {
    expect(texts("# Errors\n\n## API\n\n## Functions\n\n### Must have\n\n## Implementation notes\n\n## Section 2: Parsing")).toEqual([]);
    expect(texts("Errors\n======\n\nAPI\n---\n")).toEqual([]);
    expect(texts("1 Errors\n\n2.1 Functions\n\n3 Public API\n")).toEqual([]);
  });
  test("question-led, gerund-led and label headings are not requirements", () => {
    for (const h of ["## What should happen", "## How it should work", "## Why you should care", "## Implementing the parser", "## Step 2: Install the dependencies with npm.", "## Example: a user signs up and gets an email.", "## Goal: make link shortening fast and reliable."]) expect(texts(h)).toEqual([]);
  });
  test("neighbouring headings stay correct", () => {
    expect(texts("## Usage: overview")).toEqual([]);
    expect(texts("## Step 2: Install")).toEqual([]);
    expect(texts("### Must have\n\n### Must-haves\n\n### Should haves")).toEqual([]);
    expect(texts("## The API must return JSON")).toHaveLength(1);
  });
  test("scope-exclusion headings still skip, even when they carry a requirement signal", () => {
    expect(texts("## Non-goals: the tool should not parse YAML.\n- GUI support")).toEqual([]);
    expect(texts("## Out of scope\n\n## Future work: we should add a GUI later.")).toEqual([]);
    expect(texts("## Will not crash: the tool must exit 2 on bad input.")).toEqual(["Will not crash: the tool must exit 2 on bad input."]); // only a leading exclusion title skips
  });
  test("a heading clause shifts later ids, and an untagged one is a gap", () => {
    const set = extractClauses([ERR_HEAD, "", "## Rules", "- one", "- two"].join("\n"));
    expect(set.clauses.map((c) => c.id)).toEqual(["C1", "C2", "C3"]);
    expect(clauseGapOf(set, ["// clause: C2\nassert!(true);\n// clause: C3\nassert!(true);\n"]).join(" ")).toContain("C1");
  });
  test("under the cap heading clauses rank after bullets: the kept bullets are exactly the ones a heading-free extractor keeps", () => {
    const heads = [1, 2, 3, 4, 5].map((n) => `## The API must reject case ${n}`);
    const bullets = Array.from({ length: 41 }, (_, i) => `- bullet ${i + 1}`);
    const set = extractClauses([...heads, "", "## Details", ...bullets].join("\n"));
    expect(set.clauses.map((c) => c.text)).toEqual(bullets.slice(0, 40).map((b) => b.slice(2))); // all 40 slots go to bullets; only bullet 41 falls off, as before headings counted
    expect(set.clauses.map((c) => c.id)).toEqual(Array.from({ length: 40 }, (_, i) => `C${i + 1}`));
    expect(set.dropped).toBe(6); // the one bullet plus the five heading clauses that found no room, all disclosed
    const room = extractClauses([...heads.slice(0, 2), "", "## Details", ...bullets.slice(0, 36)].join("\n")); // 36 bullets leave 4 slots: both headings fit, in source order
    expect(room.clauses.map((c) => c.text)).toEqual([...heads.slice(0, 2).map((h) => h.slice(3)), ...bullets.slice(0, 36).map((b) => b.slice(2))]);
    expect(room.dropped).toBe(0);
    const part = extractClauses([...heads, "", "## Details", ...bullets.slice(0, 37)].join("\n")); // 37 bullets leave 3 slots: the first three headings fill them
    expect(part.clauses.map((c) => c.text)).toEqual([...heads.slice(0, 3).map((h) => h.slice(3)), ...bullets.slice(0, 37).map((b) => b.slice(2))]);
    expect(part.dropped).toBe(2);
  });
  test("a heading that repeats a bullet counts as the bullet, so the cap never drops a requirement that is also written as a bullet", () => {
    const req = "The API must reject case 1";
    const others = Array.from({ length: 40 }, (_, i) => `- bullet ${i + 1}`);
    const set = extractClauses([`## ${req}`, "", `- ${req}`, ...others].join("\n")); // 41 distinct bullets, the first one equal to the heading
    expect(set.clauses.map((c) => c.text)).toEqual([req, ...others.slice(0, 39).map((b) => b.slice(2))]);
    expect(set.dropped).toBe(1); // only bullet 40 falls off; the repeated heading is not a second clause
  });
  test("the dropped-clause note names the cap, not a position, because a dropped heading can precede kept bullets", () => {
    expect(clauseDroppedNote(1)).toBe("not_proven: 1 further acceptance clause over the 40 clause cap was not extracted");
    expect(clauseDroppedNote(6)).toBe("not_proven: 6 further acceptance clauses over the 40 clause cap were not extracted");
  });
});
