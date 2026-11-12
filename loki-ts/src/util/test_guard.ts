// util/test_guard.ts -- weakened-test detection for edited pre-existing test files. The implement and fix sessions may add to any existing test file
// (the Wall stays read-only); the edit is never reverted. Seal caps the verdict at PARTIAL and names the file when a deletion, a dropped assertion or test
// case, an added skip/only/xfail marker, or an added setup/teardown/mock/fixture construct is found (testFileWeakened). An added test block or a stricter assertion is kept and uncapped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeGit } from "./safe_git.ts";
import { literalSkeleton, pinnedLines } from "../e10ext/assert_delta.ts";
import { isTestFile } from "./test_file_text.ts";

const ASSERT_RE = /\b(?:expect|assert\w*|should|XCTAssert\w*|require\.\w+|self\.assert\w*|Assert\.\w+|t\.(?:is|not|equal|deepEqual|true|false|truthy|falsy|throws|ok|notOk|match|snapshot))\s*[(.]|^\s*assert\s/gm;
const CASE_RE = /\b(?:it|test|describe|context)\s*(?:\.each\b[^(]*)?\(|\bdef\s+test_\w+|@Test\b|\[(?:Fact|Theory|Test|TestMethod)\]|\bfunc\s+Test\w+/g;
const SKIP_RE = /\.(?:skip|only|todo|fails)\s*\(|\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|@(?:Disabled|Ignore)\b|\bt\.Skip\w*\(|\bpytest\.skip\(|\[Ignore\]/g;
// Setup, teardown, mock and fixture constructs: one added to an existing test file can neuter its existing tests without deleting an assertion (PR 472 review).
const SETUP_RE = /\b(?:beforeEach|afterEach|beforeAll|afterAll|vi\.(?:mock|doMock|spyOn|stubGlobal|stubEnv)|jest\.(?:mock|doMock|spyOn)|mock\.module|setUp|tearDown|setup_method|teardown_method|monkeypatch|autouse)\b|@pytest\.fixture\b|@(?:Before|After)(?:Each|All|Class)?\b|\[(?:SetUp|TearDown|OneTimeSetUp)\]/g;
const count = (re: RegExp, text: string): number => (text.match(re) ?? []).length;
/** True when the new text drops an assertion or a test case, or adds a skip/only/xfail marker or a setup, teardown, mock or fixture construct, compared with the base text. Only added test blocks pass. */
export function weakensTest(baseText: string, newText: string): boolean {
  return count(ASSERT_RE, newText) < count(ASSERT_RE, baseText) || count(CASE_RE, newText) < count(CASE_RE, baseText) || count(SKIP_RE, newText) > count(SKIP_RE, baseText) || count(SETUP_RE, newText) > count(SETUP_RE, baseText);
}

/** True when an edited pre-existing test file must cap the verdict: it was deleted or retyped (status D or T), or its text at headSha (null: the file on disk)
 *  weakens the base text (see weakensTest). An unreadable blob or file counts as weakened (fail-safe). Pure read, never edits the tree. */
export function testFileWeakened(repoDir: string, baseSha: string, headSha: string | null, rel: string, status: string): boolean {
  if (status === "D" || status === "T") return true;
  try { return weakensTest(safeGit(repoDir, ["show", `${baseSha}:${rel}`]), headSha === null ? readFileSync(join(repoDir, rel), "utf8") : safeGit(repoDir, ["show", `${headSha}:${rel}`])); } catch { return true; }
}

// E4 defect pin: an existing assertion that pins the wrong value the issue reports must change with the fix, so a pure value replacement of it is not "weakened".
// Always listed (never silent), never evidence for VERIFIED (provenance already marks an edited pre-existing test agent-authored), and seal requires it to fail on the base commit.
export interface DefectPinEdit { file: string; line: number; old: string; new: string }
export const defectPinNote = (e: DefectPinEdit): string => `value change (defect pin): ${e.file}:${e.line} ${e.old} -> ${e.new}`;
const MAX_PIN_FILES = 400, MAX_PIN_BYTES = 200_000;
/** Pinned assertions across the tracked test files at ref (null: the worktree). Empty when the task reports no wrong value. Pure read. */
export function findDefectPins(repoDir: string, task: string, ref: string | null = null): { file: string; line: number; text: string }[] {
  try {
    const files = safeGit(repoDir, ref ? ["ls-tree", "-r", "--name-only", ref] : ["ls-files"]).split("\n").filter((f) => f && isTestFile(f)).slice(0, MAX_PIN_FILES);
    return files.flatMap((f) => {
      let text = ""; try { text = ref ? safeGit(repoDir, ["show", `${ref}:${f}`]) : readFileSync(join(repoDir, f), "utf8"); } catch { return []; }
      return text.length > MAX_PIN_BYTES ? [] : pinnedLines(text, task).map((p) => ({ file: f, line: p.line, text: p.text.trim() }));
    });
  } catch { return []; }
}
/** The pinned lines of an edited pre-existing test that were rewritten by a pure literal replacement (same code, a different value). A structural change, a deletion or an unpinned line is not listed here. Fail closed: any error is []. */
export function defectPinEdits(repoDir: string, baseSha: string, headSha: string | null, rel: string, task: string): DefectPinEdit[] {
  try {
    const pins = pinnedLines(safeGit(repoDir, ["show", `${baseSha}:${rel}`]), task);
    if (!pins.length) return [];
    const patch = safeGit(repoDir, headSha ? ["diff", "-U0", "--no-color", `${baseSha}:${rel}`, `${headSha}:${rel}`] : ["diff", "-U0", "--no-color", baseSha, "--", rel]);
    const out: DefectPinEdit[] = []; let m: RegExpExecArray | null;
    const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@.*\n((?:[-+\\].*\n?)*)/gm;
    while ((m = hunkRe.exec(patch))) {
      const start = Number(m[1]), rem: string[] = [], add: string[] = [];
      for (const l of m[3]!.split("\n")) { if (l.startsWith("-")) rem.push(l.slice(1)); else if (l.startsWith("+")) add.push(l.slice(1)); }
      rem.forEach((old, k) => {
        const pin = pins.find((p) => p.line === start + k && p.text === old), next = add[k];
        if (!pin || next === undefined || rem.length !== add.length || literalSkeleton(old) !== literalSkeleton(next) || old.trim() === next.trim()) return;
        out.push({ file: rel, line: pin.line, old: old.trim().slice(0, 160), new: next.trim().slice(0, 160) });
      });
    }
    return out;
  } catch { return []; }
}
/** The verify "assertion value changed" notes a defect-pin edit replaces, keyed on the exact file:line of each pin edit so an unpinned edit in the same file keeps its note and its cap. Empty unless lift is on (the cap lift is a verdict change, off by default). */
export function pinDroppedNotes(verifyNotProven: readonly string[], edits: readonly DefectPinEdit[], lift: boolean): Set<string> {
  const keys = edits.map((e) => `assertion value changed (not shown to be required by the task): ${e.file}:${e.line} `);
  return new Set(lift ? verifyNotProven.filter((n) => keys.some((k) => n.startsWith(k))) : []);
}

/** Z2 LOKI_E10_PINNED_TEST_UPDATE: one updated test the session reported on an `UPDATED TEST <path>:<line>: <old> -> <new>; issue: "<sentence>"` line, checked by the harness.
 *  verified only when the file is a test file on base that the change modified, the old expectation is on base within 3 lines of <line>, the new one is in the edited file, and
 *  the quoted sentence (at least 12 characters) is in the task text; `why` names the first check that failed. The receipt lists every one (pinned_test_updates). */
export interface PinnedTestUpdate { test: string; line: number; old: string; new: string; issue: string; verified: boolean; why?: string }
const UPDATED_RE = /^\W*UPDATED TEST\s+`?([^\s`:]+):(\d+)`?:\s*(.+?)\s*->\s*(.+?)\s*;\s*issue:\s*["“](.+?)["”]\s*\.?\s*$/gm;
const flat = (t: string): string => t.replace(/[\s`]+/g, "").replace(/'/g, "\"");
export function pinnedTestUpdates(repoDir: string, baseSha: string, reply: string, task: string): PinnedTestUpdate[] {
  const out: PinnedTestUpdate[] = [];
  for (const m of (reply ?? "").matchAll(UPDATED_RE)) {
    const u: PinnedTestUpdate = { test: m[1]!, line: Number(m[2]), old: m[3]!.slice(0, 300), new: m[4]!.slice(0, 300), issue: m[5]!.slice(0, 400), verified: false };
    const fail = (why: string): void => { out.push({ ...u, why }); };
    if (!isTestFile(u.test) || u.test.split("/").includes("..")) { fail("not a test file"); continue; }
    let base: string; try { base = safeGit(repoDir, ["show", `${baseSha}:${u.test}`]); } catch { fail("not on the base commit"); continue; }
    let head: string; try { head = readFileSync(join(repoDir, u.test), "utf8"); } catch { fail("not in the edited tree"); continue; }
    if (head === base) { fail("the file is unchanged"); continue; }
    const win = base.split("\n").slice(Math.max(0, u.line - 4), u.line + 3).join("\n");
    if (!flat(win).includes(flat(u.old))) { fail("the old expectation is not at that line on base"); continue; }
    if (!flat(head).includes(flat(u.new))) { fail("the new expectation is not in the edited file"); continue; }
    if (flat(u.issue).length < 12 || !flat(task).includes(flat(u.issue))) { fail("the quoted sentence is not in the task"); continue; }
    out.push({ ...u, verified: true });
  }
  return out.slice(0, 12);
}
/** Seal: one NOT PROVEN line per reported update the harness could not check (a checked one is listed in the receipt only). */
export const pinnedUpdateNotes = (xs: readonly PinnedTestUpdate[]): string[] => xs.filter((x) => !x.verified).map((x) => `test update reported but not verified: ${x.test}:${x.line} (${x.why ?? "unchecked"})`);
