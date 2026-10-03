// P0 (FireLater#17) + D76: scope control is advisory. Edits on the issue's stated surface are in scope; anything else is flagged, never reverted.
import { describe, expect, test } from "bun:test";
import { flagOutsideScope, outsideNote, outsideScope } from "../../src/e10ext/scope.ts";

const task = "Multiple routes manually validate input. Apply validation across routes using a shared schema helper.";
const o = { intake: { task }, plan: { plan: "1. Add validate middleware. 2. Apply validation to routes.", relevant_files: ["backend/src/middleware/validate.ts"] } } as never;
const mod = (f: string) => ({ st: "M", f });
const routes = ["applications", "assets", "attachments"].map((n) => mod(`backend/src/routes/${n}.ts`));

describe("scope surface (advisory)", () => {
  test("FireLater shape: three route files are in scope, not flagged", () => {
    expect(outsideScope(o, routes)).toEqual([]);
    expect(flagOutsideScope(o, [...routes, mod("backend/src/middleware/validate.ts")])).toEqual([]);
  });
  test("truly unrelated README and infra edits are flagged outside stated scope, nothing is reverted", () => {
    const notes = flagOutsideScope(o, [...routes, mod("README.md"), mod("infra/deploy.yml")]);
    expect(notes).toEqual([outsideNote("README.md"), outsideNote("infra/deploy.yml")]);
    expect(notes[0]).toBe("outside stated scope: README.md");
  });
  test("a sibling in a planned file's directory is in scope", () => {
    expect(outsideScope(o, [mod("backend/src/middleware/auth.ts")])).toEqual([]);
  });
  test("a file named only by the contract is in scope", () => {
    const c = { ...(o as object), intake: { task, contract_snapshot: { contract: { criteria: [{ text: "docs/api.md lists every validated field" }] }, notes: [], sha256: "x" } } };
    expect(outsideScope(c as never, [mod("docs/api.md")])).toEqual([]);
    expect(outsideScope(o, [mod("docs/api.md")])).toEqual(["docs/api.md"]);
  });
  test("no scope signal stays undetermined", () => {
    expect(flagOutsideScope({ intake: { task } } as never, routes)).toEqual(["scope not determined; all edits committed"]);
  });
});
