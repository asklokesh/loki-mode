import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runIntent, workItemBlockers } from "../../src/util/run_outputs.ts";
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
  const calls: { id: string; answer: string }[] = [], out: string[] = [], err: string[] = [];
  const d: AnswerDeps = {
    repoDir: repo, env: { PATH: "/usr/bin", SLACK_BOT_TOKEN: "xoxb-secret", SLACK_SIGNING_SECRET: "s", LOKI_CONTROL_TOKEN: "t" }, answerDir,
    resume: async (id, answer) => { calls.push({ id, answer }); return 0; },
    out: (l) => out.push(l), err: (l) => err.push(l),
  };
  return { d, calls, out, err };
}

describe("fix-round spec conflict reason (FC-FIX-CONFLICT-STALLED)", () => {
  test("readBlocked and workItemBlockers show the fix round's reason, not implement's or unspecified", () => {
    const id = "e10-20261001T155511Z-fix1", repo = mkdtempSync(join(root, "repo-"));
    const ev = (seq: number, type: string, stage: string | null, data: Record<string, unknown>) => ({ v: 1, seq, ts: "2026-10-01T15:55:11.000Z", run: id, type, stage, data });
    const evs = [ev(0, "run.started", null, {}), ev(1, "stage.completed", "intake", { task: "do the thing" }), ev(2, "stage.completed", "implement", { exit: "done" }),
      ev(3, "stage.completed", "fix", { exit: "spec_conflict", spec_conflict_reason: "test demands X but spec says Y" }), ev(4, "run.completed", null, { verdict: "SPEC_CONFLICT" })];
    mkdirSync(join(repo, ".loki", "runs", id), { recursive: true });
    writeFileSync(join(repo, ".loki", "runs", id, "events.jsonl"), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(workItemBlockers(evs as never)).toEqual(["spec_conflict: test demands X but spec says Y"]);
    expect(readBlocked(repo, id)).toMatchObject({ question: "test demands X but spec says Y" });
  });
});

describe("loki answer", () => {
  test("answer file plus fixture BLOCKED run resumes that run with the saved answer", async () => {
    const repo = repoWith("blocked"), ad = join(root, "answers");
    mkdirSync(join(ad, "abc123"), { recursive: true });
    writeFileSync(join(ad, "abc123", `${BLOCKED}.answer.txt`), "keep add pure\n");
    const t = deps(repo, ad);
    expect(await runAnswer([], t.d)).toBe(0);
    expect(t.calls).toEqual([{ id: BLOCKED, answer: "keep add pure" }]);
    expect(t.out.join("\n")).toContain(BLOCKED);
  });
  test("positional text: loki answer <run-id> \"<text>\"", async () => {
    const t = deps(repoWith("blocked"), join(root, "none"));
    expect(await runAnswer([BLOCKED, "use a param"], t.d)).toBe(0);
    expect(await runAnswer(["use another"], t.d)).toBe(0);
    expect(t.calls).toEqual([{ id: BLOCKED, answer: "use a param" }, { id: BLOCKED, answer: "use another" }]);
    expect(await runAnswer([BLOCKED, "a", "--text", "b"], t.d)).toBe(2);
  });
  test("answerEnv strips Slack and control secrets and sets LOKI_NO_BROWSER", () => {
    const env = answerEnv({ PATH: "/usr/bin", SLACK_BOT_TOKEN: "xoxb-secret", SLACK_SIGNING_SECRET: "s", LOKI_CONTROL_TOKEN: "t" });
    expect(env.LOKI_NO_BROWSER).toBe("1");
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(env.SLACK_SIGNING_SECRET).toBeUndefined();
    expect(env.LOKI_CONTROL_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
  test("runIntent records actor, policy sha and parent run (redacted, validated)", () => {
    const repo = mkdtempSync(join(root, "intent-"));
    mkdirSync(join(repo, ".loki"), { recursive: true });
    writeFileSync(join(repo, ".loki", "policies.json"), "{}");
    const sha = createHash("sha256").update("use a param").digest("hex");
    const i = runIntent(repo, { LOKI_ACTOR: "ci-bot ghp_abcdefghijklmnopqrstuvwxyz0123456789", LOKI_PARENT_RUN: BLOCKED, LOKI_ANSWER_SHA: sha, HOME: repo });
    expect(String(i.actor)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(i.policy_revision).toBe(createHash("sha256").update("{}").digest("hex"));
    expect(i.parent_run).toBe(BLOCKED);
    expect(i.answered_run).toBe(BLOCKED);
    expect(i.answer_sha256).toBe(sha);
    const bad = runIntent(repo, { LOKI_ACTOR: "x", LOKI_PARENT_RUN: "../etc", LOKI_ANSWER_SHA: "nothex", HOME: repo });
    expect([bad.parent_run, bad.answered_run, bad.answer_sha256]).toEqual([null, null, null]);
  });
  test("a non-BLOCKED run exits 2 with the reason and resumes nothing", async () => {
    const repo = repoWith("verified"), t = deps(repo, join(root, "none"));
    expect(await runAnswer(["e10-verified-verified", "--text", "x"], t.d)).toBe(2);
    expect(t.err.join("\n")).toContain("not BLOCKED");
    expect(t.calls.length).toBe(0);
  });
  test("no answer, unknown run: exit 2", async () => {
    const t = deps(repoWith("blocked"), join(root, "none"));
    expect(await runAnswer([], t.d)).toBe(2);
    expect(t.err.join("\n")).toContain("no answer");
    expect(await runAnswer(["e10-nope", "--text", "x"], t.d)).toBe(2);
    expect(t.calls.length).toBe(0);
  });
  test("text needs a value: bare --text exits 2 even with a saved answer", async () => {
    const repo = repoWith("blocked"), ad = join(root, "answers-tnv");
    mkdirSync(join(ad, "abc123"), { recursive: true });
    writeFileSync(join(ad, "abc123", `${BLOCKED}.answer.txt`), "stale saved answer\n");
    const t = deps(repo, ad);
    expect(await runAnswer(["--text"], t.d)).toBe(2);
    expect(await runAnswer([BLOCKED, "--text"], t.d)).toBe(2);
    expect(t.err.join("\n")).toContain("--text needs a value");
    expect(t.calls.length).toBe(0);
    expect(await runAnswer(["--text", "x"], t.d)).toBe(0);
    expect(await runAnswer(["--text=y"], t.d)).toBe(0);
    expect(await runAnswer([], t.d)).toBe(0);
    expect(t.calls.map((c) => c.answer)).toEqual(["x", "y", "stale saved answer"]);
  });
  test("traversal run ids are rejected with exit 2", async () => {
    const repo = repoWith("blocked");
    mkdirSync(join(repo, ".loki", "evil"), { recursive: true });
    cpSync(join(FIX, "blocked", "events.jsonl"), join(repo, ".loki", "evil", "events.jsonl"));
    const t = deps(repo, join(root, "none"));
    for (const id of ["../evil", "a/b", "..", "x..y"]) expect(await runAnswer([id, "--text", "x"], t.d)).toBe(2);
    expect(readBlocked(repo, "../evil")).toContain("invalid run id");
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
    expect(t.calls[0]!.answer.length).toBe(4000);
  });
  test("default run is the newest BLOCKED one even when a later run is verified", async () => {
    const t = deps(repoWith("blocked", "verified"), join(root, "none"));
    expect(await runAnswer(["--text", "go"], t.d)).toBe(0);
    expect(t.calls[0]).toEqual({ id: BLOCKED, answer: "go" });
  });
});
