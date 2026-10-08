// SARIF-1: findings to SARIF 2.1.0. Golden shape, required fields, NOT PROVEN as note, stable fingerprints, redaction.
import { describe, expect, test } from "bun:test";
import { findingFingerprint, toSarif, type Finding } from "../../src/features/sarif.ts";

const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";

const three: Finding[] = [
  { kind: "secret", message: `found ${TOKEN}`, file: "src/a.ts", line: 10, key: "github-token" },
  { kind: "not-proven", message: "perf claim has no benchmark", file: "docs/x.md", line: 3 },
  { kind: "wall", message: "Wall check W2 failed", file: "src/b.ts" },
];

describe("toSarif", () => {
  test("golden for 3 findings", () => {
    const log = toSarif(three, "11.3.1") as any;
    const run = log.runs[0];
    expect(log.version).toBe("2.1.0");
    expect(run.tool.driver.rules.map((r: any) => r.id)).toEqual(["loki/secret-scan", "loki/not-proven", "loki/wall-failure"]);
    expect(run.results.map((r: any) => [r.ruleId, r.ruleIndex, r.level])).toEqual([
      ["loki/secret-scan", 0, "error"],
      ["loki/not-proven", 1, "note"],
      ["loki/wall-failure", 2, "error"],
    ]);
    expect(run.results[0].locations[0].physicalLocation.region.startLine).toBe(10);
    expect(run.results[2].locations[0].physicalLocation.region).toBeUndefined();
  });

  test("schema-required fields present", () => {
    const log = toSarif(three) as any;
    expect(log.$schema).toContain("sarif-2.1.0");
    expect(log.runs[0].tool.driver.name).toBeTruthy();
    for (const r of log.runs[0].results) {
      expect(typeof r.message.text).toBe("string");
      expect(r.ruleId).toBeTruthy();
      expect(r.partialFingerprints["lokiFinding/v1"]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("NOT PROVEN maps to note with ruleId loki/not-proven", () => {
    const r = (toSarif([three[1]!]) as any).runs[0].results[0];
    expect(r.level).toBe("note");
    expect(r.ruleId).toBe("loki/not-proven");
  });

  test("fingerprint stable across line shifts, differs across files", () => {
    const a = findingFingerprint({ ...three[0]!, line: 10 });
    expect(findingFingerprint({ ...three[0]!, line: 99 })).toBe(a);
    expect(findingFingerprint({ ...three[0]!, file: "src/other.ts" })).not.toBe(a);
  });

  test("no secret value appears in the output, including non-secret kinds", () => {
    const leaky: Finding[] = [...three, { kind: "verify", message: `curl -H "Authorization: Bearer ${TOKEN}"`, key: `tok ${TOKEN}` }];
    const out = JSON.stringify(toSarif(leaky));
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("a1B2c3D4e5F6");
  });
});
