import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerEnv, readAnswerFile, readBlocked, runAnswer, type AnswerDeps } from "../../src/features/blocked_answer.ts";

const FIX = join(import.meta.dir, "../../../packages/control-plane/test/fixtures/runs");
const root = mkdtempSync(join(tmpdir(), "loki-ans-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BLOCKED = "e10-20261001T155511Z-4420";
function repoWith(...fixtures: string[]): string {
  const repo = mkdtempSync(join(root, "repo-"));
  for (const f of fixtures) {
    const id = f === "blocked" ? BLOCKED : `e10-verified-${f}`;
    mkdirSync(join(repo, ".loki", "runs", id), { recursive: true });
    cpSync(join(FIX, f, "events.jsonl"), join(repo, ".loki", "runs", id, "events.jsonl"));
  }
  return repo;
}
function deps(repo: string, answerDir: string) {
  const calls: { argv: string[]; env: NodeJS.ProcessEnv }[] = [], out: string[] = [], err: string[] = [];
  const d: AnswerDeps = {
    repoDir: repo, env: { PATH: "/usr/bin", SLACK_BOT_TOKEN: "xoxb-secret", SLACK_SIGNING_SECRET: "s", LOKI_CONTROL_TOKEN: "t" }, binPath: "/x/bin/loki", answerDir,
    launch: async (argv, env) => { calls.push({ argv, env }); return { code: 0, runId: "e10-new" }; },
    out: (l) => out.push(l), err: (l) => err.push(l),
  };
  return { d, calls, out, err };
}

describe("loki answer", () => {
  test("answer file plus fixture BLOCKED run gives argv with task, question and answer", async () => {
    const repo = repoWith("blocked"), ad = join(root, "answers");
    mkdirSync(join(ad, "abc123"), { recursive: true });
    writeFileSync(join(ad, "abc123", `${BLOCKED}.answer.txt`), "keep add pure\n");
    const t = deps(repo, ad);
    expect(await runAnswer([], t.d)).toBe(0);
    const task = t.calls[0]!.argv[1]!;
    expect(t.calls[0]!.argv[0]).toBe("/x/bin/loki");
    expect(task).toContain("add a multiply(a, b) function to calc.ts");
    expect(task).toContain('Clarification answering "the task contradicts calc.ts');
    expect(task).toContain("keep add pure");
    expect(t.out.join("\n")).toContain("e10-new");
  });
  test("env has LOKI_NO_BROWSER=1 and no Slack or control secrets", async () => {
    const t = deps(repoWith("blocked"), join(root, "none"));
    await runAnswer([BLOCKED, "--text", "use a param"], t.d);
    const env = t.calls[0]!.env;
    expect(env.LOKI_NO_BROWSER).toBe("1");
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(env.SLACK_SIGNING_SECRET).toBeUndefined();
    expect(env.LOKI_CONTROL_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(answerEnv({ SLACK_X: "1" }).SLACK_X).toBeUndefined();
  });
  test("a non-BLOCKED run exits 2 with the reason and launches nothing", async () => {
    const repo = repoWith("verified"), t = deps(repo, join(root, "none"));
    expect(await runAnswer(["e10-verified-verified", "--text", "x"], t.d)).toBe(2);
    expect(t.err.join("\n")).toContain("not BLOCKED");
    expect(t.calls.length).toBe(0);
  });
  test("no answer, unknown run: exit 2", async () => {
    const t = deps(repoWith("blocked"), join(root, "none"));
    expect(await runAnswer([], t.d)).toBe(2);
    expect(t.err.join("\n")).toContain("--text");
    expect(await runAnswer(["e10-nope", "--text", "x"], t.d)).toBe(2);
    expect(t.calls.length).toBe(0);
  });
  test("traversal run ids are rejected with exit 2", async () => {
    const repo = repoWith("blocked");
    mkdirSync(join(repo, ".loki", "evil"), { recursive: true });
    cpSync(join(FIX, "blocked", "events.jsonl"), join(repo, ".loki", "evil", "events.jsonl"));
    const t = deps(repo, join(root, "none"));
    for (const id of ["../evil", "a/b", "..", "x..y"]) expect(await runAnswer([id, "--text", "x"], t.d)).toBe(2);
    expect(readBlocked(repo, "../evil")).toContain("invalid run id");
    expect(t.err.join("\n")).toContain("invalid run id");
    expect(t.calls.length).toBe(0);
    const ad = join(root, "ans2");
    mkdirSync(join(ad, "s"), { recursive: true });
    writeFileSync(join(ad, "s", "..x.answer.txt"), "leak");
    expect(readAnswerFile(ad, "../s/..x")).toBeNull();
  });
  test("answer file is capped at 4000 characters", async () => {
    const ad = join(root, "answers-big");
    mkdirSync(join(ad, "s"), { recursive: true });
    writeFileSync(join(ad, "s", `${BLOCKED}.answer.txt`), "a".repeat(9000));
    expect(readAnswerFile(ad, BLOCKED)!.length).toBe(4000);
    const t = deps(repoWith("blocked"), ad);
    await runAnswer([], t.d);
    expect(t.calls[0]!.argv[1]!.length).toBeLessThan(4600);
  });
  test("default run is the newest BLOCKED one even when a later run is verified", async () => {
    const t = deps(repoWith("blocked", "verified"), join(root, "none"));
    expect(await runAnswer(["--text", "go"], t.d)).toBe(0);
    expect(t.calls[0]!.argv[1]).toContain("go");
  });
});
