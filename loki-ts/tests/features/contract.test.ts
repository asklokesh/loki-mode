// D65-SPEC: spec to contract parsing and trace mapping.
import { describe, expect, test } from "bun:test";
import { loadContract, repoRoot, sanitizeCriterion, parseContract, sealContract, snapshotContract, traceContract, untracedLines, MAX_CRITERIA } from "../../src/features/contract.ts";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
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
});
