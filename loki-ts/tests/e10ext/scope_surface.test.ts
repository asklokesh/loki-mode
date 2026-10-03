// P0 (FireLater#17): scope control must keep edits on the issue's stated surface ("across routes") and disclose them.
import { describe, expect, test } from "bun:test";
import { keptOutsideNote, revertUnrelated, scopeDecision, unrelatedNote } from "../../src/e10ext/scope.ts";

const task = "Multiple routes manually validate input. Apply validation across routes using a shared schema helper.";
const o = { intake: { task }, plan: { plan: "1. Add validate middleware. 2. Apply validation to routes.", relevant_files: ["backend/src/middleware/validate.ts"] } } as never;
const mod = (f: string) => ({ st: "M", f });
const routes = ["applications", "assets", "attachments"].map((n) => mod(`backend/src/routes/${n}.ts`));

describe("scope surface", () => {
  test("FireLater shape: three route files are kept and disclosed, not reverted", async () => {
    const calls: string[][] = [];
    const notes = await revertUnrelated(async (a) => { calls.push(a); return { code: 0 }; }, "b".repeat(40), o, [...routes, mod("backend/src/middleware/validate.ts")]);
    expect(calls).toEqual([]);
    for (const r of routes) expect(notes).toContain(keptOutsideNote(r.f));
    expect(notes!.some((n) => n.includes("kept, outside stated scope"))).toBe(true);
  });
  test("truly unrelated README is still reverted per existing policy", () => {
    const d = scopeDecision(o, [...routes, mod("README.md"), mod("infra/deploy.yml")])!;
    expect(d.revert).toEqual(["README.md", "infra/deploy.yml"]);
    expect(d.kept).toHaveLength(3);
    expect(unrelatedNote("README.md")).toContain("README.md");
  });
  test("a sibling in a planned file's directory is kept", () => {
    expect(scopeDecision(o, [mod("backend/src/middleware/auth.ts")])!.kept).toEqual(["backend/src/middleware/auth.ts"]);
  });
  test("no scope signal stays undetermined", () => {
    expect(scopeDecision({ intake: { task } } as never, routes)).toBeNull();
  });
});
