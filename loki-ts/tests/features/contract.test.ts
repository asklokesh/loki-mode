// D65-SPEC: spec to contract parsing and trace mapping.
import { describe, expect, test } from "bun:test";
import { loadContract, repoRoot, sanitizeCriterion, parseContract, sealContract, traceContract, untracedLines, MAX_CRITERIA } from "../../src/features/contract.ts";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

describe("sealContract", () => {
  test("off by default, additive when on", () => {
    const dir = mkdtempSync(join(tmpdir(), "contract-test-"));
    mkdirSync(join(dir, ".loki"));
    writeFileSync(join(dir, ".loki", "contract.json"), JSON.stringify(parseContract(SPEC)));
    const raw = ["M", "src/export/csv.ts"];
    const off: Record<string, unknown> = {};
    expect(sealContract(dir, off, raw, [], {})).toEqual([]);
    expect(off["contract"]).toBeUndefined();
    const on: Record<string, unknown> = {};
    const lines = sealContract(dir, on, raw, [], { LOKI_CONTRACT: "1" });
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
    expect(() => sealContract(dir, body, ["M", "a.ts"], [], { LOKI_CONTRACT: "1" })).not.toThrow();
  });
  test("caps count at 50 and text length", () => {
    const crit = Array.from({ length: 80 }, (_, i) => ({ id: `AC-${i}`, text: "y".repeat(2000) }));
    const c = loadContract(mk(JSON.stringify({ source: "", criteria: crit })))!;
    expect(c.criteria.length).toBe(50);
    expect(c.criteria[0]!.text.length).toBe(500);
  });
  test("a trace failure becomes one NOT PROVEN line", () => {
    const dir = mk(JSON.stringify(parseContract(SPEC)));
    const lines = sealContract(dir, {}, null as unknown as string[], [], { LOKI_CONTRACT: "1" });
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
    const script = `import { sealContract } from ${JSON.stringify(join(import.meta.dir, "../../src/features/contract.ts"))};
console.log(JSON.stringify(sealContract(${JSON.stringify(dir)}, {}, [], [], { LOKI_CONTRACT: "1" })));`;
    const r = spawnSync("bun", ["-e", script], { env: { ...process.env, LOKI_NO_BROWSER: "1" }, encoding: "utf8", timeout: 5000 });
    expect(r.error).toBeUndefined();
    expect(JSON.parse(r.stdout.trim())).toEqual(["contract unreadable: not a regular file"]);
  });
  test("directory and symlink are not regular files", () => {
    const d1 = mkdirLoki();
    mkdirSync(join(d1, ".loki", "contract.json"));
    expect(sealContract(d1, {}, [], [], ON)).toEqual(["contract unreadable: not a regular file"]);
    const d2 = mkdirLoki();
    writeFileSync(join(d2, "real.json"), "{}");
    symlinkSync(join(d2, "real.json"), join(d2, ".loki", "contract.json"));
    expect(sealContract(d2, {}, [], [], ON)).toEqual(["contract unreadable: not a regular file"]);
  });
  test("oversize file is too large", () => {
    const d = mkdirLoki();
    writeFileSync(join(d, ".loki", "contract.json"), " ".repeat(1024 * 1024 + 1));
    expect(sealContract(d, {}, [], [], ON)).toEqual(["contract unreadable: too large"]);
  });
  test("invalid JSON is one NOT PROVEN line", () => {
    const d = mkdirLoki();
    writeFileSync(join(d, ".loki", "contract.json"), "{not json");
    const body: Record<string, unknown> = {};
    expect(sealContract(d, body, [], [], ON)).toEqual(["contract unreadable: invalid JSON"]);
    expect(body["contract"]).toBeUndefined();
  });
  test("malformed criteria are counted, valid ones still trace", () => {
    const d = mkdirLoki();
    writeFileSync(join(d, ".loki", "contract.json"), '{"source":"x","criteria":[{"id":"AC-1"},null,{"id":3,"text":"x"},{"id":"AC-2","text":"export csv files"}]}');
    const body: Record<string, unknown> = {};
    const lines = sealContract(d, body, ["M", "src/export.ts"], [], ON);
    expect(lines).toEqual(["contract: 3 malformed criteria dropped"]);
    expect((body["contract"] as { criteria: unknown[] }).criteria.length).toBe(1);
  });
  test("flag off returns [] without touching the filesystem", () => {
    const d = mkdirLoki();
    writeFileSync(join(d, ".loki", "contract.json"), "{not json");
    expect(sealContract(d, {}, [], [], {})).toEqual([]);
    expect(sealContract("/nonexistent-dir-xyz", {}, [], [], { LOKI_CONTRACT: "0" })).toEqual([]);
  });
});
