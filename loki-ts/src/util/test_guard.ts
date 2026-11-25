// util/test_guard.ts -- weakened-test detection for edited pre-existing test files. The implement and fix sessions may add to any existing test file
// (the Wall stays read-only); the edit is never reverted. Seal caps the verdict at PARTIAL and names the file when a deletion, a dropped assertion or test
// case, an added skip/only/xfail marker, or an added setup/teardown/mock/fixture construct is found (testFileWeakened). An added test block or a stricter assertion is kept and uncapped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeGit } from "./safe_git.ts";
import { escapeRegex } from "./regex_escape.ts";
import { literalSkeleton, pinnedLines } from "../e10ext/assert_delta.ts";
import { isTestFile } from "./test_file_text.ts";

const ASSERT_RE = /\b(?:expect|assert\w*|should|XCTAssert\w*|require\.\w+|self\.assert\w*|Assert\.\w+|t\.(?:is|not|equal|deepEqual|true|false|truthy|falsy|throws|ok|notOk|match|snapshot))\s*[(.]|^\s*assert\s/gm;
const CASE_RE = /\b(?:it|test|describe|context)\s*(?:\.each\b[^(]*)?\(|\bdef\s+test_\w+|@Test\b|\[(?:Fact|Theory|Test|TestMethod)\]|\bfunc\s+Test\w+/g;
const SKIP_RE = /\.(?:skip|only|todo|fails)\s*\(|\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|@(?:Disabled|Ignore)\b|\bt\.Skip\w*\(|\bpytest\.skip\(|\[Ignore\]/g;
// Setup, teardown, mock and fixture constructs: one added to an existing test file can neuter its existing tests without deleting an assertion (PR 472 review).
// Two kinds. FILE-WIDE constructs (hooks, module mocks, fixtures) reach every test in the file, so one added is always a possible weakening. PER-TEST
// constructs (a spy, a stubbed global or env var, monkeypatch) act where they are written: one added together with a new test case is that new case's own
// setup, not a change to the existing ones. A run that only ADDED a test case to an existing file, with a vi.spyOn inside it, was held at PARTIAL as
// "weakened test" with every acceptance item met.
const SETUP_RE = /\b(?:beforeEach|afterEach|beforeAll|afterAll|vi\.(?:mock|doMock)|jest\.(?:mock|doMock)|mock\.module|setUp|tearDown|setup_method|teardown_method|autouse)\b|@pytest\.fixture\b|@(?:Before|After)(?:Each|All|Class)?\b|\[(?:SetUp|TearDown|OneTimeSetUp)\]/g;
const LOCAL_SETUP_RE = /\b(?:vi\.(?:spyOn|stubGlobal|stubEnv)|jest\.spyOn|monkeypatch)\b/g;
const count = (re: RegExp, text: string): number => (text.match(re) ?? []).length;
/** True when the new text drops an assertion or a test case, or adds a skip/only/xfail marker or a setup, teardown, mock or fixture construct, compared with the base text. Only added test blocks pass. */
export function weakensTest(baseText: string, newText: string): boolean {
  const moreCases = count(CASE_RE, newText) > count(CASE_RE, baseText);
  return count(ASSERT_RE, newText) < count(ASSERT_RE, baseText) || count(CASE_RE, newText) < count(CASE_RE, baseText) || count(SKIP_RE, newText) > count(SKIP_RE, baseText) || count(SETUP_RE, newText) > count(SETUP_RE, baseText) || (!moreCases && count(LOCAL_SETUP_RE, newText) > count(LOCAL_SETUP_RE, baseText));
}

/** True when an edited pre-existing test file must cap the verdict: it was deleted or retyped (status D or T), or its text at headSha (null: the file on disk)
 *  weakens the base text (see weakensTest). An unreadable blob or file counts as weakened (fail-safe). Pure read, never edits the tree. */
export function testFileWeakened(repoDir: string, baseSha: string, headSha: string | null, rel: string, status: string, task = ""): boolean {
  if (status === "D" || status === "T") return true;
  try {
    const base = safeGit(repoDir, ["show", `${baseSha}:${rel}`]), head = headSha === null ? readFileSync(join(repoDir, rel), "utf8") : safeGit(repoDir, ["show", `${headSha}:${rel}`]);
    if (!weakensTest(base, head)) return false;
    return !weakenExcuseOn() || excusedEdit(repoDir, baseSha, headSha, rel, base, head, task) === null;
  } catch { return true; }
}
/** Why an edited test file the count rule reads as weakened is kept uncapped (FL24-WEAK), or null when it is not excused. Seal lists it on the receipt, so an excuse is never silent. */
export function weakenExcuse(repoDir: string, baseSha: string, headSha: string | null, rel: string, task = ""): string | null {
  if (!weakenExcuseOn()) return null;
  try {
    const base = safeGit(repoDir, ["show", `${baseSha}:${rel}`]), head = headSha === null ? readFileSync(join(repoDir, rel), "utf8") : safeGit(repoDir, ["show", `${headSha}:${rel}`]);
    return weakensTest(base, head) ? excusedEdit(repoDir, baseSha, headSha, rel, base, head, task) : null;
  } catch { return null; }
}

/** FL24-WEAK (LOKI_E10_WEAK_EXCUSE, default on, =0 restores the count rule alone). Two edits the count rule read as weakening are not:
 *  (1) TASK-CASE: fewer assertions only inside test cases the task names by their exact title (FireLater#24 s1: the issue asked to update
 *  'should search across title, issue_number, description' from three ILIKE assertions to two full-text ones). Every changed line must sit
 *  inside one such case on base and on head, the case keeps an assertion, and no case is dropped or skipped.
 *  (2) NEW-SCOPE SETUP, only with LOKI_E10_WEAK_MOCK_NEW=1 (off by default, lead ruling 2026-11-14): a setup hook inside a describe block the change
 *  added, a module mock whose target file is new in this change, or one whose factory only returns bare vi.fn()/jest.fn() stubs for a logging or
 *  metrics module (s2's beforeEach and its search-history, saved-filter, search-analytics and logger mocks).
 *  The task must ask for the test itself to change near the title ("the test ... is updated", "update the test"): a title quoted only as failing, or with "update the code", excuses nothing.
 *  The NEW-SCOPE clauses are OFF by default (LOKI_E10_WEAK_MOCK_NEW=1 turns them on): a mock of a new module can still reach an existing test when the change
 *  moved logic into that module. Anything else keeps the cap. Fail-safe: an unreadable diff excuses nothing. */
export const weakenExcuseOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(0|off|false|no)$/i.test((env["LOKI_E10_WEAK_EXCUSE"] ?? "").trim());
export const weakMockNewOn = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|on|true|yes)$/i.test((env["LOKI_E10_WEAK_MOCK_NEW"] ?? "").trim());
const UPDATE_ASK_RE = /\btests?\b(?:(?!\.\s)[^\n]){0,200}?\b(?:is|are|be|gets?|must be|should be)\s+(?:updated|changed|rewritten|replaced)\b|\b(?:update|change|rewrite|replace)\s+(?:the\s+|this\s+|that\s+|its\s+)?(?:existing\s+)?(?:test|assertion|expectation)s?\b/i;
/** True when the task quotes `title` and asks, within the same stretch of text (200 characters either side), for that test to be updated. */
function taskAsksUpdate(task: string, title: string): boolean {
  for (let i = task.indexOf(title); i >= 0; i = task.indexOf(title, i + 1)) if (UPDATE_ASK_RE.test(task.slice(Math.max(0, i - 200), i + title.length + 200))) return true;
  return false;
}
const CASE_START_RE = /^\s*(?:it|test)(?:\.\w+)?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;
const ANY_CASE_RE = /^\s*(?:it|test|describe|context)(?:\.\w+)?\s*\(/;
const HOOK_RE = /\b(?:beforeEach|afterEach|beforeAll|afterAll)\s*\(/;
const MOCK_RE = /\b(?:vi|jest)\.(?:mock|doMock)\s*\(\s*(['"])([^'"]+)\1/;
const OBSERVABILITY_RE = /^(?:logger|log|logging|metrics|telemetry|tracing|tracer)$/i;
const STUB_FACTORY_RE = /^\s*(?:vi|jest)\.(?:mock|doMock)\s*\(\s*['"][^'"]+['"]\s*,\s*\(\)\s*=>\s*\(\{\s*(?:\w+\s*:\s*)?\{\s*(?:\w+\s*:\s*(?:vi|jest)\.fn\(\)\s*(?:,\s*)?)+\}\s*,?\s*\}\)\s*,?\s*\)\s*;?\s*$/;
interface Hunk { b0: number; bn: number; h0: number; hn: number }
function hunksOf(patch: string): Hunk[] {
  return [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({ b0: Number(m[1]), bn: m[2] === undefined ? 1 : Number(m[2]), h0: Number(m[3]), hn: m[4] === undefined ? 1 : Number(m[4]) }));
}
/** The title of the it()/test() case that holds lines [from, to] (1-based) of `lines`, or null when the range is outside one case or crosses into another. */
function caseHolding(lines: string[], from: number, to: number): { title: string; start: number; end: number } | null {
  let start = -1;
  for (let i = Math.min(from, lines.length) - 1; i >= 0; i--) { if (CASE_START_RE.test(lines[i]!)) { start = i; break; } if (ANY_CASE_RE.test(lines[i]!) && i < from - 1) return null; }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (ANY_CASE_RE.test(lines[i]!)) { end = i; break; }
  if (to > end) return null;
  for (let i = from - 1; i < Math.min(to, lines.length); i++) if (i !== start && ANY_CASE_RE.test(lines[i]!)) return null;
  return { title: CASE_START_RE.exec(lines[start]!)![2]!, start, end };
}
function excusedEdit(repoDir: string, baseSha: string, headSha: string | null, rel: string, base: string, head: string, task: string): string | null {
  if (count(CASE_RE, head) < count(CASE_RE, base) || count(SKIP_RE, head) > count(SKIP_RE, base)) return null;
  const why: string[] = [];
  const patch = safeGit(repoDir, headSha ? ["diff", "-U0", "--no-color", `${baseSha}:${rel}`, `${headSha}:${rel}`] : ["diff", "-U0", "--no-color", baseSha, "--", rel]);
  const hunks = hunksOf(patch); if (hunks.length === 0) return null;
  const bl = base.split("\n"), hl = head.split("\n"), added = new Set<number>();
  for (const h of hunks) for (let i = 0; i < h.hn; i++) added.add(h.h0 + i);
  // (1) a dropped assertion count is excused only when every hunk that removes lines sits inside one task-named case on both sides
  if (count(ASSERT_RE, head) < count(ASSERT_RE, base)) {
    const removing = hunks.filter((h) => h.bn > 0);
    const named = removing.length > 0 && removing.every((h) => {
      const b = caseHolding(bl, h.b0, h.b0 + h.bn - 1), n = h.hn > 0 ? caseHolding(hl, h.h0, h.h0 + h.hn - 1) : caseHolding(hl, Math.max(1, h.h0), Math.max(1, h.h0));
      if (!b || !n || b.title !== n.title || b.title.length < 8 || !taskAsksUpdate(task, b.title)) return false;
      return count(ASSERT_RE, hl.slice(n.start, n.end).join("\n")) > 0;
    });
    if (!named) return null;
    why.push("fewer assertions only inside test cases the task asks to update");
  }
  // (2) every added setup construct must be one that cannot reach an existing test
  if (count(SETUP_RE, head) > count(SETUP_RE, base)) {
    const exists = (ref: string, p: string): boolean => { try { safeGit(repoDir, ["cat-file", "-e", `${ref}:${p}`], { stdio: "ignore" }); return true; } catch { return false; } };
    const onHead = (p: string): boolean => (headSha ? exists(headSha, p) : (() => { try { readFileSync(join(repoDir, p)); return true; } catch { return false; } })());
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const candidates = (spec: string): string[] => {
      const p = normalizeRel(dir ? `${dir}/${spec}` : spec); if (p === null) return [];
      const stem = p.replace(/\.(?:js|mjs|cjs|jsx)$/, "");
      return [...new Set([p, ...["ts", "tsx", "js", "mjs", "cjs", "jsx", "mts", "cts"].map((x) => `${stem}.${x}`), ...["ts", "tsx", "js"].map((x) => `${stem}/index.${x}`)])];
    };
    // A package the test's own subject starts importing (FireLater#24: header.tsx gained `useRouter` from 'next/navigation', and Header.test.tsx cannot
    // render it without mocking that package). The mock can only stand in for a dependency this file's tests never exercised, since their subject did not
    // have it. The subject is a non-test file the test imported on base by a relative path, or one with the test's stem in its directory or the parent
    // directory (names compared without case: Header.test.tsx imports '../Header', the file is header.tsx). An import gained by any other file excuses
    // nothing: a file-wide mock of a package another module already used would silence this file's existing tests. Bare package names only.
    // LOKI_E10_WEAK_MOCK_PKG=0 turns it off.
    let addedImports: string | null = null;
    const subjectOf = (): ((file: string) => boolean) => {
      const low = (x: string): string => x.toLowerCase(), up = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "", stem = (f: string): string => low(f.slice(f.lastIndexOf("/") + 1)).replace(/\.(?:test|spec)(?=\.[^.]+$)/, "").replace(/\.[^.]+$/, "");
      const imported = new Set([...base.matchAll(/(?:\bfrom\s*|\brequire\(\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].flatMap((m) => candidates(m[1]!)).map(low));
      return (file) => !isTestFile(file) && (imported.has(low(file)) || ((dir === "" ? [""] : [dir, up]).map(low).includes(low(file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "")) && stem(file) === stem(rel)));
    };
    const newlyImported = (spec: string): boolean => {
      if (/^(0|off|false|no)$/i.test((process.env["LOKI_E10_WEAK_MOCK_PKG"] ?? "").trim()) || spec.startsWith(".") || spec.startsWith("/")) return false;
      if (addedImports === null) {
        try {
          let file = ""; const keep: string[] = [], subject = subjectOf();
          for (const l of safeGit(repoDir, ["diff", "-U0", "--no-color", baseSha, ...(headSha ? [headSha] : [])]).split("\n")) {
            if (l.startsWith("+++ ")) file = l.startsWith("+++ b/") && subject(l.slice(6)) ? l.slice(6) : "";
            else if (l.startsWith("-") && !l.startsWith("---") && file) keep.push(`gone ${l.slice(1)}`);
            else if (l.startsWith("+") && !l.startsWith("+++") && file) keep.push(`new ${l.slice(1)}`);
          }
          addedImports = keep.join("\n");
        } catch { addedImports = ""; }
      }
      const q = escapeRegex(spec), imp = (kind: string): RegExp => new RegExp(`^${kind} .*(?:\\bfrom\\s*|\\brequire\\(\\s*|\\bimport\\s*\\(?\\s*)['"]${q}['"]`, "m");
      return imp("new").test(addedImports) && !imp("gone").test(addedImports); // an import that only moved (removed and added) is not new
    };
    let excused = 0;
    for (const n of added) {
      const line = hl[n - 1] ?? ""; const hits = count(SETUP_RE, line); if (hits === 0) continue;
      const m = MOCK_RE.exec(line);
      if (m) {
        const spec = m[2]!, cs = spec.startsWith(".") ? candidates(spec) : [];
        // the mock call and its factory: lines from here until the parentheses balance, all of them added
        let depth = 0, k = n - 1, body = "";
        for (; k < hl.length; k++) { body += hl[k]! + "\n"; for (const ch of hl[k]!) { if (ch === "(") depth++; else if (ch === ")") depth--; } if (depth <= 0) break; }
        const allAdded = Array.from({ length: k - (n - 1) + 1 }, (_, j) => n + j).every((x) => added.has(x));
        const fresh = cs.length > 0 && !cs.some((c) => exists(baseSha, c)) && cs.some(onHead);
        const stub = OBSERVABILITY_RE.test((spec.split("/").pop() ?? "").replace(/\.\w+$/, "")) && STUB_FACTORY_RE.test(body.replace(/\n/g, " "));
        if (weakMockNewOn() && allAdded && (fresh || stub)) { excused += hits; continue; }
        if (allAdded && newlyImported(spec)) { excused += hits; continue; }
        return null;
      }
      if (HOOK_RE.test(line)) {
        const ind = /^\s*/.exec(line)![0].length; let owner = -1;
        for (let i = n - 2; i >= 0; i--) { const l = hl[i]!; if (/\bdescribe\s*\(/.test(l) && /^\s*/.exec(l)![0].length < ind) { owner = i + 1; break; } }
        if (weakMockNewOn() && owner > 0 && added.has(owner)) { excused += hits; continue; }
        return null;
      }
      return null;
    }
    if (count(SETUP_RE, head) - excused > count(SETUP_RE, base)) return null;
    why.push("added setup only in describe blocks the change added, or mocks of modules new in the change or of a package the test's own subject starts importing");
  }
  return why.join("; ") || null;
}
const normalizeRel = (p: string): string | null => { const out: string[] = []; for (const s of p.split("/")) { if (s === "" || s === ".") continue; if (s === "..") { if (!out.length) return null; out.pop(); } else out.push(s); } return out.join("/"); };

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
