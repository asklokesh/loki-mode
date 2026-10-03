// D65-SPEC: spec to contract parsing and trace mapping.
import { describe, expect, test } from "bun:test";
import { parseContract, sealContract, traceContract, untracedLines, MAX_CRITERIA } from "../../src/features/contract.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
    expect(t.criteria[0]!.status).toBe("traced");
    expect(t.criteria[0]!.files).toEqual(["src/export/csv.ts"]);
    expect(t.criteria[0]!.checks).toEqual(["unit csv export test"]);
    expect(t.criteria[1]!.status).toBe("untraced");
    expect(untracedLines(t)).toContain("contract AC-2 untraced: Login page rejects bad passwords");
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
