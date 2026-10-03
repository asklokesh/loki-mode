// D61 slice 8 wall check: six fixture specs and a determinism test for the deterministic decomposer.
import { describe, expect, it } from "bun:test";
import { dagJson, decompose, isSharedFile, parseItems } from "../../src/features/decompose.ts";
import type { RepoMap } from "../../src/engine10/repomap.ts";

const FILES = [
  "CHANGELOG.md", "package.json", "bun.lock",
  "packages/api/package.json", "packages/api/src/export.ts", "packages/api/src/index.ts", "packages/api/src/users.ts",
  "packages/web/src/ExportButton.tsx", "packages/web/src/Nav.tsx",
  "packages/cli/src/export.ts", "src/auth.ts", "src/billing.ts", "src/util.ts",
];
const map: RepoMap = { files: FILES, entries: FILES.map((path) => ({ path, symbols: [] })), truncated: false };
const select = (task: string, m: RepoMap, max: number): string[] => {
  const words: string[] = task.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const stem = (f: string): string => (f.split("/").pop() ?? f).replace(/\.[^.]+$/, "").toLowerCase();
  return m.files.filter((f) => words.includes(stem(f))).slice(0, max);
};
const opts = { select, workspaces: ["packages/api", "packages/web", "packages/cli"] };
const run = (spec: string) => decompose(spec, map, opts);

describe("decompose", () => {
  it("1: three disjoint bullets give three parallel units", () => {
    const d = run("- fix auth token\n- update billing totals\n- tidy util helpers");
    expect(d.units.map((u) => u.writeSet)).toEqual([["src/auth.ts"], ["src/billing.ts"], ["src/util.ts"]]);
    expect(d.edges).toEqual([]);
  });
  it("2: numbered items touching the same file are unioned", () => {
    const d = run("1. add users endpoint in packages/api/src/users.ts\n2. validate users input\n3. fix billing");
    expect(d.units.length).toBe(2);
    expect(d.units[0]!.items.length).toBe(2);
    expect(d.units[0]!.writeSet).toEqual(["packages/api/src/users.ts"]);
  });
  it("3: shared files are serialized, not in write sets, and chained by edges", () => {
    const d = run("- update auth and note in CHANGELOG.md\n- update billing and note in CHANGELOG.md");
    expect(d.units.length).toBe(2);
    expect(d.units.every((u) => u.writeSet.length === 1 && u.serialized.join() === "CHANGELOG.md")).toBe(true);
    expect(d.edges).toEqual([{ from: "u1", to: "u2", via: "CHANGELOG.md" }]);
    expect(d.sharedFiles).toEqual(["CHANGELOG.md"]);
  });
  it("4: issue checklist with workspaces reports module boundaries", () => {
    const d = run("## Tasks\n- [ ] export api\n- [x] ExportButton in web\n- [ ] export cli");
    // "export api" and "export cli" both match every export.ts file, so they union; the web item is separate
    expect(d.units.length).toBe(2);
    expect(d.units[0]!.modules).toEqual(["packages/api", "packages/cli"]);
    expect(d.units[0]!.writeSet).toEqual(["packages/api/src/export.ts", "packages/cli/src/export.ts"]);
    expect(d.units[1]!.modules).toEqual(["packages/web"]);
  });
  it("5: headings are items when there are no list lines", () => {
    expect(parseItems("# Spec\n## auth work\n## billing work")).toEqual(["Spec", "auth work", "billing work"]);
    const d = run("# Spec\n## auth work\nstuff\n## billing work\nmore");
    expect(d.units.some((u) => u.writeSet.join() === "src/auth.ts")).toBe(true);
    expect(d.units.some((u) => u.writeSet.join() === "src/billing.ts")).toBe(true);
  });
  it("6: plain prose with no structure is one unit; empty spec has none", () => {
    expect(run("make the auth and billing flow better").units.length).toBe(1);
    expect(run("   \n").units.length).toBe(0);
  });
  it("shared file classifier", () => {
    for (const f of ["package.json", "a/bun.lock", "x/index.ts", "CHANGELOG.md", "pkg/__init__.py"]) expect(isSharedFile(f)).toBe(true);
    expect(isSharedFile("src/auth.ts")).toBe(false);
  });
  it("is deterministic: same input gives byte-identical JSON", () => {
    const spec = "- fix auth\n- fix billing and CHANGELOG.md\n- export api\n- export cli and CHANGELOG.md";
    const a = dagJson(run(spec));
    for (let i = 0; i < 5; i++) expect(dagJson(run(spec))).toBe(a);
    const shuffled = { ...map, files: [...FILES].reverse() };
    expect(dagJson(decompose(spec, shuffled, opts))).toBe(a);
  });
});
