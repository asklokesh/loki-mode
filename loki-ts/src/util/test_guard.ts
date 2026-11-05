// util/test_guard.ts -- weakened-test detection for edited pre-existing test files. The implement and fix sessions may add to any existing test file
// (the Wall stays read-only); the edit is never reverted. Seal caps the verdict at PARTIAL and names the file when a deletion, a dropped assertion or test
// case, or an added skip/only/xfail marker is found (testFileWeakened). An added case or a stricter assertion is kept and uncapped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeGit } from "./safe_git.ts";

const ASSERT_RE = /\b(?:expect|assert\w*|should|XCTAssert\w*|require\.\w+|self\.assert\w*|Assert\.\w+|t\.(?:is|not|equal|deepEqual|true|false|truthy|falsy|throws|ok|notOk|match|snapshot))\s*[(.]|^\s*assert\s/gm;
const CASE_RE = /\b(?:it|test|describe|context)\s*(?:\.each\b[^(]*)?\(|\bdef\s+test_\w+|@Test\b|\[(?:Fact|Theory|Test|TestMethod)\]|\bfunc\s+Test\w+/g;
const SKIP_RE = /\.(?:skip|only|todo|fails)\s*\(|\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|@(?:Disabled|Ignore)\b|\bt\.Skip\w*\(|\bpytest\.skip\(|\[Ignore\]/g;
const count = (re: RegExp, text: string): number => (text.match(re) ?? []).length;
/** True when the new text drops an assertion or a test case, or adds a skip/only/xfail marker, compared with the base text. */
export function weakensTest(baseText: string, newText: string): boolean {
  return count(ASSERT_RE, newText) < count(ASSERT_RE, baseText) || count(CASE_RE, newText) < count(CASE_RE, baseText) || count(SKIP_RE, newText) > count(SKIP_RE, baseText);
}

/** True when an edited pre-existing test file must cap the verdict: it was deleted or retyped (status D or T), or its text at headSha (null: the file on disk)
 *  weakens the base text (see weakensTest). An unreadable blob or file counts as weakened (fail-safe). Pure read, never edits the tree. */
export function testFileWeakened(repoDir: string, baseSha: string, headSha: string | null, rel: string, status: string): boolean {
  if (status === "D" || status === "T") return true;
  try { return weakensTest(safeGit(repoDir, ["show", `${baseSha}:${rel}`]), headSha === null ? readFileSync(join(repoDir, rel), "utf8") : safeGit(repoDir, ["show", `${headSha}:${rel}`])); } catch { return true; }
}
