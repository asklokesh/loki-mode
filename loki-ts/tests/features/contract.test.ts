// D65-SPEC: spec to contract parsing and trace mapping.
import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { loadContract, repoRoot, sanitizeCriterion, parseContract, sealContract, snapshotContract, traceContract, untracedLines, MAX_CRITERIA, fromChecklist, fromPrdText, fromSpecText, mapRequirements, readRequirementsMap, renderRequirementsMap, writeFromChecklist, writeFromEngine10, type RanCheck } from "../../src/features/contract.ts";
import { formatRunSummary, withNextLine } from "../../src/util/run_summary.ts";
import { SPEC_MARKER, renderSpec } from "../../src/util/spec_file.ts";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SPEC = `# Widget PRD

Intro text with - a dash.

## Acceptance criteria
- Users can export reports as csv
1. Login page rejects bad passwords
2. **Rate limit** applies to the api

## Notes
- not a criterion

## Tasks
- [ ] Add csv export endpoint
- [x] Add csv export endpoint
\`\`\`
- [ ] inside fence
\`\`\`
`;

describe("parseContract", () => {
  test("collects section bullets, numbered items and checklists, deduped", () => {
    const c = parseContract(SPEC, "spec.md");
    expect(c.criteria.map((x) => x.id)).toEqual(["AC-1", "AC-2", "AC-3", "AC-4"]);
    expect(c.criteria[0]!.text).toBe("Users can export reports as csv");
    expect(c.criteria[2]!.text).toBe("Rate limit applies to the api");
    expect(c.criteria[3]!.text).toBe("Add csv export endpoint");
    expect(c.criteria[0]!.source_line).toBe(6);
  });
  test("no criteria for a plain document", () => {
    expect(parseContract("# Title\n- just a bullet\n").criteria).toEqual([]);
  });
  test("caps at 50", () => {
    const md = Array.from({ length: 80 }, (_, i) => `- [ ] criterion number ${i}`).join("\n");
    expect(parseContract(md).criteria.length).toBe(MAX_CRITERIA);
  });
});

describe("traceContract", () => {
  test("maps by keyword overlap; untraced when no file matches", () => {
    const c = parseContract(SPEC);
    const t = traceContract(c, ["src/export/csv.ts", "README.md"], ["unit csv export test"]);
    expect(t.criteria[0]!.status).toBe("keyword_match");
    expect(t.criteria[0]!.files).toEqual(["src/export/csv.ts"]);
    expect(t.criteria[0]!.checks).toEqual(["unit csv export test"]);
    expect(t.criteria[1]!.status).toBe("no_match");
    expect(untracedLines(t)).toContain("contract AC-2 untraced (no keyword match in changed files): Login page rejects bad passwords");
  });
});

/** Snapshot at "intake", then seal: what the engine does with the file untouched in between. */
function sealSnap(dir: string, body: object, raw: string[], checks: { name: string }[], env: NodeJS.ProcessEnv): string[] {
  return sealContract(dir, body, raw, checks, env, snapshotContract(dir, env));
}

describe("sealContract", () => {
  test("off by default, additive when on", () => {
    const dir = mkdtempSync(join(tmpdir(), "contract-test-"));
    mkdirSync(join(dir, ".loki"));
    writeFileSync(join(dir, ".loki", "contract.json"), JSON.stringify(parseContract(SPEC)));
    const raw = ["M", "src/export/csv.ts"];
    const off: Record<string, unknown> = {};
    expect(sealSnap(dir, off, raw, [], { LOKI_CONTRACT: "0" })).toEqual([]);
    expect(off["contract"]).toBeUndefined();
    const on: Record<string, unknown> = {};
    const lines = sealSnap(dir, on, raw, [], { LOKI_CONTRACT: "1" });
    expect(on["contract"]).toBeDefined();
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("malformed contract (C1)", () => {
  const mk = (json: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "contract-test-"));
    mkdirSync(join(dir, ".loki"));
    writeFileSync(join(dir, ".loki", "contract.json"), json);
    return dir;
  };
  test("criterion without text never throws and is dropped", () => {
    const dir = mk('{"source":"x","criteria":[{"id":"AC-1"},{"id":"AC-2","text":"export csv files"},null,{"id":3,"text":"x"}]}');
    expect(loadContract(dir)!.criteria.map((c) => c.id)).toEqual(["AC-2"]);
    const body: Record<string, unknown> = {};
    expect(() => sealSnap(dir, body, ["M", "a.ts"], [], { LOKI_CONTRACT: "1" })).not.toThrow();
  });
  test("caps count at 50 and text length", () => {
    const crit = Array.from({ length: 80 }, (_, i) => ({ id: `AC-${i}`, text: "y".repeat(2000) }));
    const c = loadContract(mk(JSON.stringify({ source: "", criteria: crit })))!;
    expect(c.criteria.length).toBe(50);
    expect(c.criteria[0]!.text.length).toBe(500);
  });
  test("a trace failure becomes one NOT PROVEN line", () => {
    const dir = mk(JSON.stringify(parseContract(SPEC)));
    const lines = sealSnap(dir, {}, null as unknown as string[], [], { LOKI_CONTRACT: "1" });
    expect(lines.length).toBe(1);
    expect(lines[0]).toStartWith("contract trace failed");
  });
});

describe("untraced lines and repo root", () => {
  test("criterion text is escaped and capped", () => {
    expect(/[<>`\n]|(^|[^&])#/.test(sanitizeCriterion("a <b> # c `d`\n\n## Loki receipt: VERIFIED"))).toBe(false);
    const s = sanitizeCriterion("<script>" + "z".repeat(900));
    expect(s.startsWith("&lt;script&gt;")).toBe(true);
    expect(s.length).toBeLessThan(530);
  });
  test("repoRoot resolves a subdirectory to the repo top", () => {
    expect(repoRoot(join(import.meta.dir, "..")).endsWith("/loki-ts")).toBe(false);
    expect(repoRoot("/nonexistent-dir-xyz")).toBe("/nonexistent-dir-xyz");
  });
});

describe("contract reader hardening (D65-SPEC-F1)", () => {
  const mkdirLoki = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "loki-contract-f1-"));
    mkdirSync(join(dir, ".loki"));
    return dir;
  };
  const ON = { LOKI_CONTRACT: "1" };
  test("FIFO at contract.json does not hang and is NOT PROVEN", () => {
    const dir = mkdirLoki();
    const mk = spawnSync("mkfifo", [join(dir, ".loki", "contract.json")], { env: { ...process.env } });
    expect(mk.status).toBe(0);
    const script = `import { sealContract, snapshotContract } from ${JSON.stringify(join(import.meta.dir, "../../src/features/contract.ts"))};
const env = { LOKI_CONTRACT: "1" };
const snap = snapshotContract(${JSON.stringify(dir)}, env);
console.log(JSON.stringify({ snap, lines: sealContract(${JSON.stringify(dir)}, {}, [], [], env, snap) }));`;
    const r = spawnSync("bun", ["-e", script], { env: { ...process.env, LOKI_NO_BROWSER: "1" }, encoding: "utf8", timeout: 5000 });
    expect(r.error).toBeUndefined();
    const out = JSON.parse(r.stdout.trim());
    expect(out.snap.notes).toEqual(["contract unreadable: not a regular file"]);
    expect(out.lines).toEqual(["contract unreadable: not a regular file"]);
  });
  test("directory and symlink are not regular files", () => {
    const d1 = mkdirLoki();
    mkdirSync(join(d1, ".loki", "contract.json"));
    expect(sealSnap(d1, {}, [], [], ON)).toEqual(["contract unreadable: not a regular file"]);
    const d2 = mkdirLoki();
    writeFileSync(join(d2, "real.json"), "{}");
    symlinkSync(join(d2, "real.json"), join(d2, ".loki", "contract.json"));
    expect(sealSnap(d2, {}, [], [], ON)).toEqual(["contract unreadable: not a regular file"]);
  });
  test("oversize file is too large", () => {
    const d = mkdirLoki();
    writeFileSync(join(d, ".loki", "contract.json"), " ".repeat(1024 * 1024 + 1));
    expect(sealSnap(d, {}, [], [], ON)).toEqual(["contract unreadable: too large"]);
  });
  test("invalid JSON is one NOT PROVEN line", () => {
    const d = mkdirLoki();
    writeFileSync(join(d, ".loki", "contract.json"), "{not json");
    const body: Record<string, unknown> = {};
    expect(sealSnap(d, body, [], [], ON)).toEqual(["contract unreadable: invalid JSON"]);
    expect(body["contract"]).toBeUndefined();
  });
  test("malformed criteria are counted, valid ones still trace", () => {
    const d = mkdirLoki();
    writeFileSync(join(d, ".loki", "contract.json"), '{"source":"x","criteria":[{"id":"AC-1"},null,{"id":3,"text":"x"},{"id":"AC-2","text":"export csv files"}]}');
    const body: Record<string, unknown> = {};
    const lines = sealSnap(d, body, ["M", "src/export.ts"], [], ON);
    expect(lines).toEqual(["contract: 3 malformed criteria dropped"]);
    expect((body["contract"] as { criteria: unknown[] }).criteria.length).toBe(1);
  });
  test("LOKI_CONTRACT=0 returns [] without touching the filesystem", () => {
    const d = mkdirLoki();
    writeFileSync(join(d, ".loki", "contract.json"), "{not json");
    const body: Record<string, unknown> = {};
    expect(sealSnap(d, body, [], [], { LOKI_CONTRACT: "0" })).toEqual([]);
    expect(body).toEqual({});
    expect(sealSnap("/nonexistent-dir-xyz", {}, [], [], { LOKI_CONTRACT: "0" })).toEqual([]);
  });
  test("unset is on by default but a missing contract.json gives no lines", () => {
    const d = mkdirLoki();
    const body: Record<string, unknown> = {};
    expect(sealSnap(d, body, ["M", "a.ts"], [], {})).toEqual([]);
    expect(body).toEqual({});
    expect(sealSnap("/nonexistent-dir-xyz", {}, [], [], {})).toEqual([]);
    writeFileSync(join(d, ".loki", "contract.json"), "{not json");
    expect(sealSnap(d, {}, [], [], {})).toEqual(["contract unreadable: invalid JSON"]);
  });
});

describe("contract frozen at intake (D65-SPEC-F2)", () => {
  const ON = { LOKI_CONTRACT: "1" };
  const two = JSON.stringify({ source: "s", criteria: [{ id: "AC-1", text: "export csv files", source_line: 1 }, { id: "AC-2", text: "login rejects bad passwords", source_line: 2 }] }, null, 2);
  const one = JSON.stringify({ source: "s", criteria: [{ id: "AC-1", text: "export csv files", source_line: 1 }] }, null, 2);
  const mk = (json?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "loki-contract-f2-"));
    mkdirSync(join(dir, ".loki"));
    if (json !== undefined) writeFileSync(join(dir, ".loki", "contract.json"), json);
    return dir;
  };
  const f = (d: string): string => join(d, ".loki", "contract.json");
  const raw = ["M", "src/export/csv.ts"];
  type Traced = { criteria: { id: string }[]; sha256?: string };
  test("W1 edit after intake: traces the intake copy and flags the change", () => {
    const d = mk(two);
    const snap = snapshotContract(d, ON);
    writeFileSync(f(d), one);
    const body: Record<string, unknown> = {};
    const lines = sealContract(d, body, raw, [], ON, snap);
    expect((body["contract"] as Traced).criteria.map((c) => c.id)).toEqual(["AC-1", "AC-2"]);
    expect(lines.filter((l) => l.startsWith("contract changed after intake (sha "))).toHaveLength(1);
    expect(lines.some((l) => l.endsWith("; traced the intake copy"))).toBe(true);
  });
  test("W2 created after intake: ignored and flagged", () => {
    const d = mk();
    const snap = snapshotContract(d, ON);
    writeFileSync(f(d), two);
    const body: Record<string, unknown> = {};
    const lines = sealContract(d, body, raw, [], ON, snap);
    expect(body["contract"]).toBeUndefined();
    expect(lines).toEqual(["contract created after intake; ignored"]);
  });
  test("W3 deleted after intake: intake copy traced and flagged", () => {
    const d = mk(two);
    const snap = snapshotContract(d, ON);
    rmSync(f(d));
    const body: Record<string, unknown> = {};
    const lines = sealContract(d, body, raw, [], ON, snap);
    expect((body["contract"] as Traced).criteria).toHaveLength(2);
    expect(lines).toContain("contract removed after intake; traced the intake copy");
  });
  test("W4 unchanged: no drift line and sha256 is the hash of the file bytes", () => {
    const d = mk(two);
    const snap = snapshotContract(d, ON);
    const body: Record<string, unknown> = {};
    const lines = sealContract(d, body, raw, [], ON, snap);
    expect(lines.some((l) => l.includes("after intake"))).toBe(false);
    expect((body["contract"] as Traced).sha256).toBe(createHash("sha256").update(readFileSync(f(d))).digest("hex"));
  });
  test("no snapshot while enabled: live file ignored", () => {
    const d = mk(two);
    const body: Record<string, unknown> = {};
    expect(sealContract(d, body, raw, [], ON, undefined)).toEqual(["contract not snapshotted at intake; ignored"]);
    expect(body["contract"]).toBeUndefined();
    expect(sealContract(mk(), {}, raw, [], ON, undefined)).toEqual([]);
  });
  test("W6 LOKI_CONTRACT=0: no snapshot, no field, no lines", () => {
    const d = mk(two);
    const off = { LOKI_CONTRACT: "0" };
    expect(snapshotContract(d, off)).toBeUndefined();
    const body: Record<string, unknown> = {};
    expect(sealContract(d, body, raw, [], off, { contract: null, notes: [], sha256: null })).toEqual([]);
    expect(body).toEqual({});
  });
  test("W7 FIFO at intake: snapshot returns fast with not a regular file", () => {
    const d = mk();
    expect(spawnSync("mkfifo", [f(d)]).status).toBe(0);
    const t0 = Date.now();
    const snap = snapshotContract(d, ON)!;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(snap.notes).toEqual(["contract unreadable: not a regular file"]);
    expect(snap.sha256).toBeNull();
    expect(sealContract(d, {}, raw, [], ON, snap)).toEqual(["contract unreadable: not a regular file"]);
  });
  test("unreadable at intake, replaced by a regular file later: flagged as created and ignored", () => {
    const d = mk();
    expect(spawnSync("mkfifo", [f(d)]).status).toBe(0);
    const snap = snapshotContract(d, ON);
    rmSync(f(d));
    writeFileSync(f(d), two);
    const body: Record<string, unknown> = {};
    const lines = sealContract(d, body, raw, [], ON, snap);
    expect(body["contract"]).toBeUndefined();
    expect(lines).toContain("contract created after intake; ignored");
  });
});

const REQ_PRD = [
  "# Todo app",
  "",
  "- Users can create a todo item with a title",
  "- Users can delete a todo item from the list",
  "- Todo items persist across a page reload",
  "",
].join("\n");

describe("requirements map (REQTRACE)", () => {
  let dir = "", loki = "", runDir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loki-reqtrace-"));
    execFileSync("git", ["init", "-q"], { cwd: dir, env: { PATH: process.env.PATH ?? "" } });
    loki = join(dir, ".loki"); runDir = join(loki, "runs", "e10-x");
    mkdirSync(runDir, { recursive: true });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const ev = (name: string, result: string, cmd = ""): { type: string; data: Record<string, unknown> } => ({ type: "test.result", data: { name, result, cmd } });
  const mapPath = (): string => join(loki, "state", "requirements-map.json");
  it("heuristic mapping: REQ_PRD units matched to a passing check by shared words", () => {
    const m = writeFromEngine10(dir, loki, runDir, REQ_PRD, [ev("bun:tests/todo_create_delete.test.ts", "pass", "bun test create delete todo item")]);
    expect(m).not.toBeNull();
    const disk = JSON.parse(readFileSync(mapPath(), "utf8"));
    expect(Object.keys(disk).sort()).toEqual(["requirements", "revision", "version"]);
    expect(disk.version).toBe(1);
    const byText = (t: string) => disk.requirements.find((r: { text: string }) => r.text.includes(t));
    expect(byText("create a todo item").status).toBe("covered");
    expect(byText("create a todo item").method).toBe("heuristic");
    expect(byText("create a todo item").checks).toEqual(["bun:tests/todo_create_delete.test.ts"]);
    expect(byText("persist across").status).toBe("uncovered");
  });

  it("explicit mapping: spec criterion linked by [check: id] counts only when that check passed", () => {
    writeFileSync(join(runDir, "spec.snapshot.md"), renderSpec("todo app", { intent: "todo list", criteria: ["Create works [check: bun:a.test.ts]", "Delete works [check: bun:b.test.ts]", "Reload keeps items [check: bun:missing.test.ts]"] }));
    const m = writeFromEngine10(dir, loki, runDir, "todo app", [ev("bun:a.test.ts", "pass"), ev("bun:b.test.ts", "fail")])!;
    expect(m.requirements.map((r) => [r.id, r.status, r.method, r.checks])).toEqual([
      ["R1", "covered", "explicit", ["bun:a.test.ts"]],
      ["R2", "uncovered", "explicit", []],
      ["R3", "uncovered", "explicit", []],
    ]);
    expect(m.requirements[0]!.text).toBe("Create works");
  });

  it("flaky or not_run checks never cover a requirement", () => {
    const reqs = fromSpecText(renderSpec("t", { intent: "i", criteria: ["Create works [check: c1, c2]"] }))!;
    const ran: RanCheck[] = [{ id: "c1", label: "", passed: false }, { id: "c2", label: "", passed: false }];
    expect(mapRequirements(reqs, ran, "abc").requirements[0]!.status).toBe("uncovered");
  });

  it("no REQ_PRD: a one-line brief writes no file and does not crash", () => {
    expect(writeFromEngine10(dir, loki, runDir, "fix the typo in the header", [ev("bun:a.test.ts", "pass")])).toBeNull();
    expect(existsSync(mapPath())).toBe(false);
    expect(writeFromEngine10(dir, loki, runDir, null, [])).toBeNull();
    expect(existsSync(mapPath())).toBe(false);
    expect(fromSpecText("not a spec")).toBeNull();
    expect(fromPrdText("short")).toBeNull();
  });

  it("checklist source: items are explicit requirements, only passed verification covers", () => {
    mkdirSync(join(loki, "checklist"), { recursive: true });
    writeFileSync(join(loki, "checklist", "checklist.json"), JSON.stringify({ categories: [{ items: [
      { id: "a1", title: "Login page exists", verification: [{ type: "file_exists", passed: true }] },
      { id: "a2", title: "Logout works", verification: [{ type: "tests_pass", passed: false }] },
      { id: "a3", title: "Pending item", verification: [{ type: "command", passed: null }] },
      { id: "a4", title: "No check item", verification: [] },
    ] }] }));
    expect(fromChecklist(loki)?.reqs.length).toBe(4);
    const m = writeFromChecklist(dir, loki)!;
    expect(m.requirements.map((r) => r.status)).toEqual(["covered", "uncovered", "uncovered", "uncovered"]);
    expect(m.requirements.every((r) => r.method === "explicit")).toBe(true);
    expect(m.requirements[0]!.checks).toEqual(["a1:file_exists:1"]);
    expect(readRequirementsMap(loki)?.requirements.length).toBe(4);
    expect(renderRequirementsMap(m)).toContain("1/4 covered");
  });

  it("no checklist: nothing written", () => {
    expect(writeFromChecklist(dir, loki)).toBeNull();
    expect(existsSync(mapPath())).toBe(false);
  });

  it("run summary names uncovered requirements within the 8 line cap", () => {
    const ui = { result: "verified" as const, filesChanged: 2, costUsd: 0.1, elapsedS: 5, next: "loki diff", uncovered: 2 };
    expect(formatRunSummary(ui)).toContain("2 requirements uncovered, see: loki plan --requirements");
    const six = "a\nb\nc\nd\ne\nf\n";
    const out = withNextLine(six, ui);
    expect(out.trimEnd().split("\n").length).toBeLessThanOrEqual(8);
    expect(out).toContain("requirements uncovered");
    const seven = withNextLine("a\nb\nc\nd\ne\nf\ng\n", ui);
    expect(seven.trimEnd().split("\n").length).toBe(7);
    expect(withNextLine(six, { ...ui, uncovered: 0 })).not.toContain("uncovered");
  });

  it("spec marker constant stays the parser's first line", () => {
    expect(renderSpec("t", { intent: "i", criteria: ["c"] }).split("\n")[0]).toBe(SPEC_MARKER);
  });
});
