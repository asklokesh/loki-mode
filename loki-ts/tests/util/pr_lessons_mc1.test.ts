import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatLessonList, learnFromPr, lessonsPath, loadLessons, type GhClient } from "../../src/util/pr_lessons.ts";

const dirs: string[] = [];
const mk = (): string => { const d = mkdtempSync(join(tmpdir(), "mc1-lessons-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const COMMENTS = [{ html_url: "https://github.com/o/r/pull/7#discussion_r1", body: "Always validate the pagination cursor before querying.", path: "src/page.ts", user: { login: "rev" } }];
const ghFor = (o: { commits?: unknown; body?: string | null; commitsCode?: number }): GhClient => async (args) => {
  const url = args[args.length - 1]!;
  if (url.endsWith("/comments")) return { code: 0, stdout: JSON.stringify(COMMENTS), stderr: "" };
  if (url.endsWith("/reviews")) return { code: 0, stdout: "[]", stderr: "" };
  if (url.endsWith("/commits")) return { code: o.commitsCode ?? 0, stdout: JSON.stringify(o.commits ?? []), stderr: "" };
  return { code: 0, stdout: JSON.stringify({ merged_at: "2026-10-01T00:00:00Z", html_url: "https://github.com/o/r/pull/7", body: o.body ?? null }), stderr: "" };
};
const trailerCommits = (runId: string): unknown => [{ commit: { message: `loki: add paging\n\nLoki-Run: ${runId}\n` } }];
const writeReceipt = (d: string, runId: string, r: Record<string, unknown>): void => {
  const p = join(d, ".loki", "runs", runId, "receipt.json");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(r));
};
const okVerify = async (): Promise<{ verdict: "VERIFIED"; reasons: string[]; receiptSha256: string }> => ({ verdict: "VERIFIED", reasons: [], receiptSha256: "abc123" });

describe("MC-1 lesson cites the receipt of the PR's run", () => {
  it("a Loki-Run trailer with a verifying local receipt yields justified_by", async () => {
    const d = mk();
    writeReceipt(d, "e10-1", { verdict: "VERIFIED", receipt_sha256: "abc123" });
    await learnFromPr(d, "o/r#7", ghFor({ commits: trailerCommits("e10-1") }), () => new Date(0), { verify: okVerify });
    const l = loadLessons(d)[0]!;
    expect(l.justified_by).toEqual({ run_id: "e10-1", receipt_sha256: "abc123", verdict: "VERIFIED" });
    expect(l.text).toBe("Always validate the pagination cursor before querying.");
    const out = formatLessonList(loadLessons(d));
    expect(out).toContain("receipt e10-1 abc123 VERIFIED");
  });

  it("a missing local receipt is unverified, never a claimed verdict", async () => {
    const d = mk();
    await learnFromPr(d, "o/r#7", ghFor({ commits: trailerCommits("e10-gone") }), () => new Date(0), { verify: okVerify });
    expect(loadLessons(d)[0]!.justified_by).toEqual({ run_id: "e10-gone", receipt_sha256: null, verdict: "unverified" });
    expect(formatLessonList(loadLessons(d))).toContain("receipt e10-gone unverified");
  });

  it("a receipt that does not verify is unverified and its hash is not stored", async () => {
    const d = mk();
    writeReceipt(d, "e10-2", { verdict: "VERIFIED", receipt_sha256: "forged" });
    const bad = async (): Promise<{ verdict: "TAMPERED"; reasons: string[] }> => ({ verdict: "TAMPERED", reasons: ["x"] });
    await learnFromPr(d, "o/r#7", ghFor({ commits: trailerCommits("e10-2") }), () => new Date(0), { verify: bad });
    expect(loadLessons(d)[0]!.justified_by).toEqual({ run_id: "e10-2", receipt_sha256: null, verdict: "unverified" });
  });

  it("the default verifier rejects an unsigned or inconsistent receipt", async () => {
    const d = mk();
    writeReceipt(d, "e10-3", { verdict: "VERIFIED", receipt_sha256: "not-the-real-hash", verification: { jwt: null } });
    await learnFromPr(d, "o/r#7", ghFor({ commits: trailerCommits("e10-3") }), () => new Date(0));
    expect(loadLessons(d)[0]!.justified_by?.verdict).toBe("unverified");
  });

  it("the MARK-1 PR body receipt block is a fallback source of the run id", async () => {
    const d = mk();
    writeReceipt(d, "e10-4", { verdict: "PARTIAL", receipt_sha256: "h4" });
    const body = "summary\n\n## Loki receipt: PARTIAL\n\n- Run: e10-4\n- receipt_sha256: h4\n";
    const v = async (): Promise<{ verdict: "VERIFIED"; reasons: string[]; receiptSha256: string }> => ({ verdict: "VERIFIED", reasons: [], receiptSha256: "h4" });
    await learnFromPr(d, "o/r#7", ghFor({ body }), () => new Date(0), { verify: v });
    expect(loadLessons(d)[0]!.justified_by).toEqual({ run_id: "e10-4", receipt_sha256: "h4", verdict: "PARTIAL" });
  });

  it("a non-Loki PR has no justified_by and lists 'no receipt'", async () => {
    const d = mk();
    await learnFromPr(d, "o/r#7", ghFor({ commits: [{ commit: { message: "plain commit" } }] }), () => new Date(0), { verify: okVerify });
    expect(loadLessons(d)[0]!.justified_by).toBeUndefined();
    expect(formatLessonList(loadLessons(d))).toContain("no receipt");
  });

  it("a failing commits call does not block learning and cites nothing", async () => {
    const d = mk();
    const r = await learnFromPr(d, "o/r#7", ghFor({ commitsCode: 1 }), () => new Date(0), { verify: okVerify });
    expect(r.added).toBe(1);
    expect(loadLessons(d)[0]!.justified_by).toBeUndefined();
  });

  it("a hostile run id never reaches the filesystem path", async () => {
    const d = mk();
    await learnFromPr(d, "o/r#7", ghFor({ commits: trailerCommits("../../etc") }), () => new Date(0), { verify: okVerify });
    expect(loadLessons(d)[0]!.justified_by).toBeUndefined();
  });

  it("writes version 2 and still loads a version 1 file", async () => {
    const d = mk();
    await learnFromPr(d, "o/r#7", ghFor({}), () => new Date(0), { verify: okVerify });
    expect(JSON.parse(readFileSync(lessonsPath(d), "utf-8")).version).toBe(2);
    const old = { version: 1, lessons: [{ id: "prl-old", text: "old lesson", source: { pr: "o/r#1", pr_url: "u", comment_url: "c", kind: "review", author: "a" }, learned_at: "t", uses: [] }] };
    const d2 = mk();
    mkdirSync(dirname(lessonsPath(d2)), { recursive: true });
    writeFileSync(lessonsPath(d2), JSON.stringify(old));
    const ls = loadLessons(d2);
    expect(ls.length).toBe(1);
    expect(ls[0]!.justified_by).toBeUndefined();
    expect(formatLessonList(ls)).toContain("no receipt");
  });
});
