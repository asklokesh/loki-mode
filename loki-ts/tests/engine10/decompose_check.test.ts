// D61 slice 9 wall check: sequential fixtures return sequential with a reason; malformed model JSON keeps the DAG.
import { describe, expect, it } from "bun:test";
import { decompose } from "../../src/features/decompose.ts";
import { checkDecomposable, overlapRatio, parseConfirm } from "../../src/features/speed/decompose_check.ts";
import type { RepoMap } from "../../src/engine10/repomap.ts";

const FILES = ["CHANGELOG.md", "src/auth.ts", "src/billing.ts", "src/util.ts", "src/token.ts"];
const SYMS: Record<string, string[]> = { "src/token.ts": ["signToken"], "src/auth.ts": ["login"] };
const map: RepoMap = { files: FILES, entries: FILES.map((path) => ({ path, symbols: SYMS[path] ?? [] })), truncated: false };
const select = (task: string, m: RepoMap, max: number): string[] => {
  const words: string[] = task.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  return m.files.filter((f) => words.includes((f.split("/").pop() ?? f).replace(/\.[^.]+$/, "").toLowerCase())).slice(0, max);
};
const dagOf = (spec: string) => decompose(spec, map, { select });
const PAR = "- fix auth flow\n- update billing totals\n- tidy util helpers";

describe("decompose_check", () => {
  it("disjoint units are parallel", async () => {
    const r = await checkDecomposable(dagOf(PAR), { map });
    expect(r.mode).toBe("parallel");
    expect(r.confirmed).toBe("none");
  });
  it("single unit is sequential with a reason", async () => {
    const r = await checkDecomposable(dagOf("- fix auth flow\n- login for auth"), { map });
    expect(r.mode).toBe("sequential");
    expect(r.reason).toContain("need at least 2");
  });
  it("shared-file overlap at or above 0.2 is sequential", async () => {
    const d = dagOf("- fix auth, note CHANGELOG.md\n- fix billing, note CHANGELOG.md");
    expect(overlapRatio(d)).toBeGreaterThanOrEqual(0.2);
    const r = await checkDecomposable(d, { map });
    expect(r.mode).toBe("sequential");
    expect(r.reason).toContain("overlap");
  });
  it("a unit reading a symbol another unit creates is sequential", async () => {
    const r = await checkDecomposable(dagOf("- add signToken helper in token\n- billing should call signToken"), { map });
    expect(r.mode).toBe("sequential");
    expect(r.reason).toContain("signToken");
  });
  it("an oversized unit is sequential", async () => {
    const r = await checkDecomposable(dagOf(PAR), { map, sizeUnit: (u) => (u.id === "u2" ? "large" : "small") });
    expect(r.mode).toBe("sequential");
    expect(r.reason).toContain("u2");
  });
  it("sequential result never calls the model", async () => {
    let calls = 0;
    await checkDecomposable(dagOf("- fix auth flow"), { map, confirm: async () => { calls++; return "{}"; } });
    expect(calls).toBe(0);
  });
  it("malformed or throwing model output keeps the deterministic DAG", async () => {
    const d = dagOf(PAR);
    for (const bad of ["not json", "[]", '{"verdict":"merge"}', '{"verdict":"merge","merges":[["u1","zz"]]}', '{"verdict":"confirm","x":1}', '{"verdict":"merge","merges":[["u1"]]}']) {
      const r = await checkDecomposable(d, { map, confirm: async () => bad });
      expect(r.confirmed).toBe("invalid");
      expect(r.dag).toEqual(d);
      expect(r.mode).toBe("parallel");
    }
    const t = await checkDecomposable(d, { map, confirm: async () => { throw new Error("boom"); } });
    expect(t.confirmed).toBe("invalid");
    expect(t.dag).toEqual(d);
  });
  it("valid confirm keeps the DAG; valid merge combines units and rechecks", async () => {
    const d = dagOf(PAR);
    const c = await checkDecomposable(d, { map, confirm: async () => '{"verdict":"confirm"}' });
    expect(c.confirmed).toBe("model");
    expect(c.dag).toEqual(d);
    const m = await checkDecomposable(d, { map, confirm: async () => '{"verdict":"merge","merges":[["u1","u2"]]}' });
    expect(m.dag.units.length).toBe(2);
    expect(m.dag.units[0]!.writeSet).toEqual(["src/auth.ts", "src/billing.ts"]);
    expect(m.mode).toBe("parallel");
    const all = await checkDecomposable(d, { map, confirm: async () => '{"verdict":"merge","merges":[["u1","u2","u3"]]}' });
    expect(all.mode).toBe("sequential");
  });
  it("parseConfirm rejects duplicate ids across groups", () => {
    expect(parseConfirm('{"verdict":"merge","merges":[["u1","u2"],["u2","u3"]]}', dagOf(PAR))).toBeNull();
  });
});
