// INTEL-3: reviewer-first PR body: contract, criteria with files and check, NOT PROVEN last, line budget.
import { describe, expect, test } from "bun:test";
import { formatDuration } from "../../src/engine10/output.ts";
import { unitTableLines } from "../../src/features/speed/seal_group.ts";
import { PR_BODY_LINE_BUDGET, renderPrBody, type PrBodyInput } from "../../src/engine10/pr_body.ts";

const base = (over: Partial<PrBodyInput> = {}): PrBodyInput => ({
  verdict: "VERIFIED", notProven: ["full suite", "app boot"], receiptPath: "/r/receipt.json", capHit: false,
  outputs: {
    intake: { task: "Fix the parser\n- handles empty input\n- rejects bad tokens" },
    verify: { changed_files: ["src/parser.ts", "tests/parser.test.ts"], checks: [{ name: "wall_parser.test.ts", cmd: "bun test", result: "pass" }] },
    wall: { files: [{ path: "tests/wall_parser.test.ts", sha256: "x" }] },
  },
  ...over,
});

describe("renderPrBody reviewer-first", () => {
  test("contract first, each criterion lists its file and check, NOT PROVEN last", () => {
    const lines = renderPrBody(base()).trimEnd().split("\n");
    expect(lines[0]).toBe("Contract: Fix the parser");
    for (const c of ["handles empty input", "rejects bad tokens"]) {
      const i = lines.findIndex((l) => l === `- ${c}`);
      expect(i).toBeGreaterThan(0);
      expect(lines[i + 1]).toContain("src/parser.ts");
      expect(lines[i + 1]).toContain("check (shared by all criteria): Wall wall_parser.test.ts (pass)");
    }
    const np = lines.indexOf("NOT PROVEN:");
    expect(np).toBeGreaterThan(lines.indexOf("Receipt: /r/receipt.json"));
    expect(lines.slice(np)).toEqual(["NOT PROVEN:", "- full suite", "- app boot"]);
  });
  test("explicit criteria rows win; missing proof reads honestly", () => {
    const body = renderPrBody(base({ criteria: [{ text: "a", files: ["f.ts"], check: "bun test f" }, { text: "b" }] }));
    expect(body).toContain("files: f.ts; check: bun test f");
    expect(body).toContain("files not recorded; check: no check recorded");
  });
  test("over budget truncates with +N more, NOT PROVEN still last, never exceeds budget", () => {
    const criteria = Array.from({ length: 80 }, (_, i) => ({ text: `crit ${i}`, files: ["a.ts"], check: "t" }));
    const body = renderPrBody(base({ criteria, notProven: Array.from({ length: 30 }, (_, i) => `np ${i}`) }));
    const lines = body.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(PR_BODY_LINE_BUDGET);
    expect(body).toMatch(/\+\d+ more criteria/);
    expect(lines[lines.length - 1]).toMatch(/^\+\d+ more not-proven items$/);
    expect(lines.indexOf("NOT PROVEN:")).toBeGreaterThan(lines.findIndex((l) => /^\+\d+ more criteria$/.test(l)));
  });
  test("within budget prints no +N more line", () => {
    expect(renderPrBody(base())).not.toContain("more");
  });
});

describe("INTEL-3 round 2 regressions", () => {
  const withChecks = (checks: unknown[], wallFiles: string[]): PrBodyInput => base({
    outputs: { intake: { task: "Fix\n- c1\n- c2" }, verify: { changed_files: ["a.ts"], checks }, wall: { files: wallFiles.map((p) => ({ path: p, sha256: "x" })) } },
  });
  test("F1: a failing or unrun Wall file never appears as a proving check; unproven criteria feed NOT PROVEN", () => {
    const body = renderPrBody(withChecks([{ name: "wall_p.test.ts", cmd: "t", result: "fail" }], ["tests/wall_p.test.ts", "tests/wall_q.test.ts"]));
    expect(body).not.toMatch(/check[^\n]*wall_p\.test\.ts \(fail\)/);
    expect(body).not.toContain("Wall wall_p");
    expect(body).toContain("UNPROVEN");
    expect(body).toContain("wall_p.test.ts failed");
    const np = body.slice(body.indexOf("NOT PROVEN:"));
    expect(np).toContain("c1");
    expect(np).toContain("c2");
  });
  test("F1: a passing Wall check is shown as proving, labelled shared; a criterion with none reads no check recorded", () => {
    const ok = renderPrBody(withChecks([{ name: "wall_p.test.ts", cmd: "t", result: "pass" }, { name: "wall_q.test.ts", cmd: "t", result: "fail" }], ["tests/wall_p.test.ts", "tests/wall_q.test.ts"]));
    expect(ok).toContain("check (shared by all criteria): Wall wall_p.test.ts (pass)");
    expect(ok).not.toContain("wall_q.test.ts (");
    const none = renderPrBody(base({ outputs: { intake: { task: "Fix\n- c1" }, verify: { changed_files: ["a.ts"] } } }));
    expect(none).toContain("check (shared by all criteria): no check recorded");
    expect(none.slice(none.indexOf("NOT PROVEN:"))).toContain("c1");
  });
  test("F2: legacy path is byte-identical to the pre-change renderer, including overflow cases", () => {
    const legacy = (i: PrBodyInput & { g?: string[] }): string => {
      const lines = [`Verdict: ${i.verdict}`, ""];
      const st = Object.entries(i.outputs).filter(([, d]) => typeof d?.["duration_s"] === "number");
      if (st.length > 0) lines.push("Stage times:", ...st.map(([n, d]) => `- ${n}: ${formatDuration(d!["duration_s"] as number)}`), "");
      lines.push("NOT PROVEN:", ...(i.notProven.length > 0 ? i.notProven.map((p) => `- ${p}`) : ["- none"]));
      if (i.receiptPath) lines.push("", `Receipt: ${i.receiptPath}`);
      if (i.g) lines.push("", ...i.g);
      return `${lines.join("\n")}\n`;
    };
    const outputs: Record<string, Record<string, unknown>> = {};
    for (let n = 0; n < 12; n++) outputs[`stage${n}`] = { duration_s: n + 1 };
    const group = { group_id: "g", units: Array.from({ length: 20 }, (_, n) => ({ index: n, unit_id: `u${n}`, goal: "g", files: ["a.ts"], tests: 1, tokens: 1, model: "m", verdict: "VERIFIED" })) };
    const cases: PrBodyInput[] = [
      { verdict: "VERIFIED", notProven: Array.from({ length: 15 }, (_, n) => `item ${n}`), receiptPath: "/r", capHit: false, outputs: {} },
      { verdict: "PARTIAL", notProven: ["x".repeat(300)], receiptPath: null, capHit: true, outputs: {} },
      { verdict: "VERIFIED", notProven: [], receiptPath: null, capHit: false, outputs: outputs as never },
      { verdict: "VERIFIED", notProven: ["a"], receiptPath: "/r", capHit: false, outputs: {}, group: group as never },
    ];
    for (const c of cases) {
      const ref = legacy({ ...c, ...(c.capHit ? {} : {}), g: c.group ? unitTableLines(c.group) : undefined });
      const want = c.capHit ? ref.replace("Verdict: PARTIAL", "Verdict: PARTIAL (DRAFT: global cap fired)") : ref;
      expect(renderPrBody(c)).toBe(want);
    }
  });
});
