// T3 Intent card v1: parsing, plan brief off-identity, plan stage output, PR body inclusion, LOKI_CONFIRM y/n/no-TTY.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlanBrief, planStage } from "../../src/engine10/stages/plan.ts";
import { runPr } from "../../src/engine10/stages/pr.ts";
import {
  confirmIntent, INTENT_CARD_INSTRUCTION, intentCardEnabled, intentSection, NOT_STATED_LINE, parseIntentCard, readAnswerFile, writeAnswerFile,
} from "../../src/util/intent_card.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner, StageName } from "../../src/engine10/types.ts";

const CARD3 = ["What I think you want: a search ranking tweak", "Acceptance: ranking test passes", "Acceptance: no other file changes"];

describe("parseIntentCard", () => {
  test("3 lines parse and are removed from the plan text", () => {
    const r = parseIntentCard(["step 1", "step 2", ...CARD3].join("\n"));
    expect(r.card).toEqual(CARD3);
    expect(r.rest).toBe("step 1\nstep 2");
  });
  test("5 lines parse intact", () => {
    const five = [...CARD3, "Acceptance: c", "Acceptance: d"];
    expect(parseIntentCard(five.join("\n")).card).toEqual(five);
  });
  test("missing card is null and the raw plan is untouched", () => {
    const raw = "step 1\nstep 2";
    expect(parseIntentCard(raw)).toEqual({ card: null, rest: raw });
  });
  test("a header with fewer than 3 lines is not a card", () => {
    expect(parseIntentCard("step 1\nWhat I think you want: x\nAcceptance: y").card).toBeNull();
  });
  test("over-long card is cut to 5 lines", () => {
    const long = [...CARD3, "Acceptance: c", "Acceptance: d", "Acceptance: e", "Acceptance: f"];
    const r = parseIntentCard(long.join("\n"));
    expect(r.card?.length).toBe(5);
    expect(r.card?.[4]).toBe("Acceptance: d");
  });
});

describe("plan brief", () => {
  test("off (default arg) is byte-identical to the pre-T3 brief", () => {
    const before = buildPlanBrief("t", ["a.ts"], "/r/plan-output.txt");
    expect(buildPlanBrief("t", ["a.ts"], "/r/plan-output.txt", undefined, false, false)).toBe(before);
    expect(before).not.toContain("What I think you want");
  });
  test("on adds exactly the instruction", () => {
    const off = buildPlanBrief("t", [], "/r/plan-output.txt");
    const on = buildPlanBrief("t", [], "/r/plan-output.txt", undefined, false, true);
    expect(on).toContain(INTENT_CARD_INSTRUCTION);
    expect(on.replace(`\n\n${INTENT_CARD_INSTRUCTION}`, "")).toBe(off);
  });
  test("LOKI_INTENT_CARD=0 is the only opt-out", () => {
    expect(intentCardEnabled({ LOKI_INTENT_CARD: "0" })).toBe(false);
    expect(intentCardEnabled({})).toBe(true);
    expect(intentCardEnabled({ LOKI_INTENT_CARD: "1" })).toBe(true);
  });
});

class Fake implements SessionRunner {
  briefs: string[] = [];
  constructor(private write: (o: SessionRunOptions) => void) {}
  async run(o: SessionRunOptions): Promise<SessionResult> { this.briefs.push(o.brief); this.write(o); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0.1, killed: false }; }
}
function ctxFor(dir: string, s: SessionRunner, emitted: unknown[] = []): RunContext {
  return {
    runId: "e10-t3", repoDir: "/tmp/nope", runDir: dir, baseSha: "x", branch: "loki/e10-t3", provider: "claude", model: "m", deep: false, capS: 900,
    emit: (type, stage, data) => { emitted.push({ type, stage, data }); }, sessions: s,
    tests: { async detect() { return { runners: [], tests: [] }; }, impacted() { return []; } },
    cost: { read() { return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; } },
    clock: { now: () => 0 }, outputs: () => ({ intake: { task: "add search ranking" } }) as Partial<Record<StageName, Record<string, unknown>>>,
  };
}

let dir: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["LOKI_INTENT_CARD", "LOKI_CONFIRM", "LOKI_INTENT_TTY"];
let errs: string[];
const realWrite = process.stderr.write.bind(process.stderr);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-t3-"));
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  errs = [];
  process.stderr.write = ((s: string | Uint8Array) => { errs.push(String(s)); return true; }) as typeof process.stderr.write;
});
afterEach(() => {
  process.stderr.write = realWrite;
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(dir, { recursive: true, force: true });
});
const planWith = (text: string) => new Fake(() => writeFileSync(join(dir, "plan-output.txt"), text, "utf8"));

describe("plan stage intent card", () => {
  test("prints the card and records it in stage data", async () => {
    const s = planWith(["step 1", ...CARD3].join("\n"));
    const r = await planStage.run(ctxFor(dir, s), new AbortController().signal);
    expect(r.data.intent_card).toEqual(CARD3);
    expect(r.data.plan).toBe("step 1");
    expect(errs.join("")).toContain("What I think you want: a search ranking tweak");
    expect(s.briefs[0]).toContain(INTENT_CARD_INSTRUCTION);
  });
  test("no parseable card prints NOT STATED and never invents one", async () => {
    const r = await planStage.run(ctxFor(dir, planWith("step 1\nstep 2")), new AbortController().signal);
    expect(r.data.intent_card).toBeNull();
    expect(errs.join("")).toContain(NOT_STATED_LINE);
  });
  test("empty plan is silent: no stderr line and no PR intent section", async () => {
    const r = await planStage.run(ctxFor(dir, planWith("  \n")), new AbortController().signal);
    expect(errs.join("")).not.toContain("Intent");
    expect("intent_enabled" in r.data).toBe(false);
    expect(intentSection(r.data)).toBe("");
  });
  test("LOKI_INTENT_CARD=0: old brief, no output, no new data keys", async () => {
    process.env.LOKI_INTENT_CARD = "0";
    const s = planWith(["step 1", ...CARD3].join("\n"));
    const r = await planStage.run(ctxFor(dir, s), new AbortController().signal);
    expect(s.briefs[0]).toBe(buildPlanBrief("add search ranking", [], join(dir, "plan-output.txt"), join(dir, "plan-scope.json"), false, false, false, true)); // card off: only the reviewer-brief risk line is added
    expect(errs.join("")).not.toContain("What I think you want");
    expect("intent_card" in r.data).toBe(false);
    expect("intent_enabled" in r.data).toBe(false);
  });
});

describe("LOKI_CONFIRM", () => {
  const mk = (tty: boolean, a: "y" | "n") => { const said: string[] = []; return { said, io: { tty, ask: async () => a, say: (l: string) => { said.push(l); } } }; };
  test("y proceeds", async () => { const { io } = mk(true, "y"); expect(await confirmIntent(CARD3, io)).toBe("yes"); });
  test("n stops with a clear message", async () => {
    const { io, said } = mk(true, "n");
    expect(await confirmIntent(CARD3, io)).toBe("no");
    expect(said.join("")).toContain("Stopped at the intent card");
  });
  test("no TTY never blocks and says so", async () => {
    const { io, said } = mk(false, "n");
    expect(await confirmIntent(CARD3, io)).toBe("skipped");
    expect(said.join("")).toContain("skipped");
  });
  test("stage without a TTY: skipped message, run continues", async () => {
    process.env.LOKI_CONFIRM = "1";
    const r = await planStage.run(ctxFor(dir, planWith(CARD3.join("\n"))), new AbortController().signal);
    expect(errs.join("")).toContain("Intent confirmation skipped");
    expect(r.data.intent_declined).toBeUndefined();
  });
  test("stage with TTY: n answer marks the run declined", async () => {
    process.env.LOKI_CONFIRM = "1"; process.env.LOKI_INTENT_TTY = "1";
    const ev: unknown[] = [];
    writeAnswerFile(dir, "n");
    const r = await planStage.run(ctxFor(dir, planWith(CARD3.join("\n")), ev), new AbortController().signal);
    expect(r.data.intent_declined).toBe(true);
    expect(errs.join("")).toContain("Stopped at the intent card");
    expect(JSON.stringify(ev)).toContain("intent_confirm");
  });
  test("stage with TTY: y answer continues", async () => {
    process.env.LOKI_CONFIRM = "1"; process.env.LOKI_INTENT_TTY = "1";
    writeAnswerFile(dir, "y");
    const r = await planStage.run(ctxFor(dir, planWith(CARD3.join("\n"))), new AbortController().signal);
    expect(r.data.intent_declined).toBeUndefined();
  });
  test("readAnswerFile times out to null", async () => { expect(await readAnswerFile(dir, 150, 20)).toBeNull(); });
});

describe("PR body", () => {
  test("intentSection renders the card, NOT STATED, or nothing when off", () => {
    expect(intentSection({ intent_enabled: true, intent_card: CARD3 })).toContain(`## Intent\n\n${CARD3.join("\n")}`);
    expect(intentSection({ intent_enabled: true, intent_card: null })).toContain(NOT_STATED_LINE);
    expect(intentSection({ plan: "x" })).toBe("");
    expect(intentSection(undefined)).toBe("");
  });
  test("runPr writes the Intent section into pr-body.md", async () => {
    const repo = mkdtempSync(join(tmpdir(), "loki-t3-repo-"));
    for (const a of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "t"], ["commit", "-q", "--allow-empty", "-m", "i"]]) execFileSync("git", a, { cwd: repo, stdio: "pipe" });
    const stub = join(dir, "stub.sh");
    writeFileSync(stub, '#!/bin/sh\n[ "$1" = push-pr ] && echo https://github.com/o/r/pull/1\nexit 0\n', { mode: 0o755 });
    const base = ctxFor(dir, planWith(""));
    const ctx = { ...base, repoDir: repo, pinnedOrigin: "https://github.com/o/r.git", outputs: () => ({ seal: { verdict: "VERIFIED", not_proven: [] }, plan: { intent_enabled: true, intent_card: CARD3 } }) } as unknown as RunContext;
    const res = await runPr(ctx, new AbortController().signal, { pushScriptPath: stub });
    expect(res.status).toBe("completed");
    expect(existsSync(join(dir, "pr-body.md"))).toBe(true);
    expect(readFileSync(join(dir, "pr-body.md"), "utf8")).toContain("## Intent\n\nWhat I think you want: a search ranking tweak");
    rmSync(repo, { recursive: true, force: true });
  });
});
