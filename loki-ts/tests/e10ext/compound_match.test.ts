// linkedHits: compound keyword match, suffix rejection, vendored skip, import-line requirement.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { linkedHits } from "../../src/e10ext/compound_match.ts";
import type { RepoMap } from "../../src/engine10/repomap.ts";
import type { TestMap } from "../../src/engine10/types.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function setup(files: Record<string, string>, srcPath: string, symbols: string[], testPath: string): { repo: RepoMap; tm: TestMap; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cm-"));
  dirs.push(dir);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  const repo: RepoMap = { files: [srcPath], entries: [{ path: srcPath, symbols }], truncated: false };
  const tm = { runners: [], tests: [{ path: testPath }] } as unknown as TestMap;
  return { repo, tm, dir };
}

describe("linkedHits", () => {
  test("glued adjacent parts link source and test", () => {
    const { repo, tm, dir } = setup(
      { "src/search-command.tsx": "export const SearchCommand = 1;\n", "src/search-command.test.tsx": 'import { SearchCommand } from "./search-command";\n' },
      "src/search-command.tsx", ["SearchCommand"], "src/search-command.test.tsx",
    );
    const hits = linkedHits("searchcommand", repo, tm, dir);
    expect(hits.map((h) => h.source)).toEqual(["code", "test"]);
    expect(hits[0]).toEqual({ source: "code", path: "src/search-command.tsx", line: "SearchCommand" });
    expect(hits[1]).toEqual({ source: "test", path: "src/search-command.test.tsx", line: "src/search-command.test.tsx" });
  });

  test("prefix compound: 5+ char stem token fronts a longer keyword", () => {
    const { repo, tm, dir } = setup(
      { "src/search.ts": "x", "src/search.test.ts": 'import { searchBar } from "./search";\n' },
      "src/search.ts", ["searchBar"], "src/search.test.ts",
    );
    expect(linkedHits("searchbar", repo, tm, dir).length).toBe(2);
  });

  test("suffix word is rejected (exporting is not a compound of export)", () => {
    const { repo, tm, dir } = setup(
      { "src/export.ts": "x", "src/export.test.ts": 'import { exportAll } from "./export";\n' },
      "src/export.ts", ["exportAll"], "src/export.test.ts",
    );
    expect(linkedHits("exporting", repo, tm, dir)).toEqual([]);
  });

  test("vendored source and vendored test paths are skipped", () => {
    const a = setup(
      { "vendor/search.ts": "x", "vendor/search.test.ts": 'import { searchBar } from "./search";\n' },
      "vendor/search.ts", ["searchBar"], "vendor/search.test.ts",
    );
    expect(linkedHits("searchbar", a.repo, a.tm, a.dir)).toEqual([]);
    const b = setup(
      { "src/search.ts": "x", "node_modules/pkg/search.test.ts": 'import { searchBar } from "./search";\n' },
      "src/search.ts", ["searchBar"], "node_modules/pkg/search.test.ts",
    );
    expect(linkedHits("searchbar", b.repo, b.tm, b.dir)).toEqual([]);
  });

  test("test must name the stem on an import line, not in a comment or string", () => {
    const { repo, tm, dir } = setup(
      { "src/search.ts": "x", "src/search.test.ts": '// import { searchBar } from "./search";\nconst s = "search";\n' },
      "src/search.ts", ["searchBar"], "src/search.test.ts",
    );
    expect(linkedHits("searchbar", repo, tm, dir)).toEqual([]);
  });

  test("unreadable test file is skipped, not thrown", () => {
    const { repo, tm, dir } = setup({ "src/search.ts": "x" }, "src/search.ts", ["searchBar"], "src/search.test.ts");
    expect(linkedHits("searchbar", repo, tm, dir)).toEqual([]);
  });
});
