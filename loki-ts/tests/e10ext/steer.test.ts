// Operator steer on engine10: HUMAN_INPUT.md is injected into the next plan/implement brief once, then archived.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINISH_LINE } from "../../src/e10ext/context.ts";
import { STEER_BEGIN, STEER_END, consumeSteer, type IntentRevision, readIntentRevisions, staleAtSeal, staleWallRevisions, withSteer } from "../../src/util/steer.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const repo = (steer?: string): string => {
  const d = mkdtempSync(join(tmpdir(), "steer-test-")); dirs.push(d);
  mkdirSync(join(d, ".loki"));
  if (steer !== undefined) writeFileSync(join(d, ".loki", "HUMAN_INPUT.md"), steer);
  return d;
};
const archived = (d: string): string[] => { try { return readdirSync(join(d, ".loki", "logs")); } catch { return []; } };

describe("engine10 steer", () => {
  test("implement brief gets the block before FINISH_LINE, file archived", () => {
    const d = repo("## Operator directive\nskip the docs\n");
    const brief = `rules\n\ntask\n\n${FINISH_LINE}`;
    const out = withSteer({ stage: "implement", brief }, d).brief as string;
    expect(out.startsWith("rules\n\ntask\n\n")).toBe(true);
    expect(out.endsWith(FINISH_LINE)).toBe(true);
    expect(out).toContain(STEER_BEGIN);
    expect(out).toContain("skip the docs");
    expect(out).toContain(STEER_END);
    expect(existsSync(join(d, ".loki", "HUMAN_INPUT.md"))).toBe(false);
    expect(archived(d).some((f) => f.startsWith("human-input-"))).toBe(true);
  });

  test("applies once", () => {
    const d = repo("do X");
    expect((withSteer({ stage: "plan", brief: "b" }, d).brief as string)).toContain("do X");
    expect(withSteer({ stage: "implement", brief: "b" }, d).brief).toBe("b");
  });

  test("other stages and absent file leave the brief untouched and keep the file", () => {
    const d = repo("do X");
    expect(withSteer({ stage: "verify", brief: "b" }, d).brief).toBe("b");
    expect(existsSync(join(d, ".loki", "HUMAN_INPUT.md"))).toBe(true);
    expect(withSteer({ stage: "implement", brief: "b" }, repo()).brief).toBe("b");
  });

  test("symlink rejected, empty file archived without injection, opt-out honoured", () => {
    const d = repo();
    writeFileSync(join(d, "target.md"), "evil");
    symlinkSync(join(d, "target.md"), join(d, ".loki", "HUMAN_INPUT.md"));
    expect(consumeSteer(d)).toBeNull();
    expect(existsSync(join(d, ".loki", "HUMAN_INPUT.md"))).toBe(false);
    expect(consumeSteer(repo("  \n"))).toBeNull();
    const o = repo("x");
    expect(consumeSteer(o, { LOKI_PROMPT_INJECTION: "0" })).toBeNull();
    expect(existsSync(join(o, ".loki", "HUMAN_INPUT.md"))).toBe(true);
  });
  test("header-bearing steers are archived with a numbered revision record, rev incrementing across steers", () => {
    const hdr = (n: number, src: string): string => `## Operator directive rev ${n} (2026-10-15T00:00:0${n}Z) actor=alice source=${src}\n`;
    const d = repo(`${hdr(1, "cli")}keep the old API\n\n${hdr(2, "https://github.com/o/r/issues/7#issuecomment-9")}also add tests\n\n`);
    const text = consumeSteer(d)!;
    expect(text).toContain("keep the old API");
    expect(text).toContain("also add tests");
    const log = () => readFileSync(join(d, ".loki", "intent-revisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log().map((r) => r.rev)).toEqual([1, 2]);
    expect(log()[0]).toMatchObject({ actor: "alice", source: "cli" });
    expect(log()[1].source).toBe("https://github.com/o/r/issues/7#issuecomment-9");
    expect(JSON.stringify(log())).not.toContain("keep the old API");
    writeFileSync(join(d, ".loki", "HUMAN_INPUT.md"), `${hdr(3, "chat")}third\n`);
    consumeSteer(d);
    expect(log().map((r) => r.rev)).toEqual([1, 2, 3]);
  });

  test("a headerless steer still gets the next revision number with null actor", () => {
    const d = repo("plain note");
    consumeSteer(d);
    writeFileSync(join(d, ".loki", "HUMAN_INPUT.md"), "another");
    consumeSteer(d);
    const rows = readFileSync(join(d, ".loki", "intent-revisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.map((r) => r.rev)).toEqual([1, 2]);
    expect(rows[0].actor).toBeNull();
  });

  test("consume returns the records to the sink even when the repo file is a /dev/null symlink; staleness is judged on Wall start in memory", () => {
    const d = repo("## Operator directive rev 1 (2026-10-15T00:00:01Z) actor=alice source=chat\nchange it\n");
    symlinkSync("/dev/null", join(d, ".loki", "intent-revisions.jsonl"));
    const sink: IntentRevision[] = [];
    consumeSteer(d, process.env, () => new Date(5000), sink);
    expect(sink.map((r) => [r.rev, r.actor, r.source, r.at])).toEqual([[1, "alice", "chat", 5000]]);
    const wall = (startMs: number) => [{ stage: "wall", startMs }];
    expect(staleWallRevisions(sink, wall(4000)).map((r) => r.rev)).toEqual([1]);
    expect(staleWallRevisions(sink, wall(5000)).map((r) => r.rev)).toEqual([1]); // same tick: the Wall never receives steers, so a tie is late
    expect(staleWallRevisions(sink, wall(5001))).toEqual([]);
    expect(staleWallRevisions(sink, [])).toEqual([]); // no Wall yet
    expect(staleWallRevisions(sink, [...wall(4000), ...wall(6000)])).toEqual([]); // re-authored
    expect(staleWallRevisions(undefined, wall(1))).toEqual([]);
  });
  test("audit file replaced by a directory, or unreadable (chmod 000): the sink still gets the record and the steer is still injected", () => {
    const hdr1 = "## Operator directive rev 1 (2026-10-15T00:00:01Z) actor=alice source=chat\nchange it\n";
    const d1 = repo(hdr1), sink1: IntentRevision[] = [];
    mkdirSync(join(d1, ".loki", "intent-revisions.jsonl"));
    expect(consumeSteer(d1, process.env, () => new Date(5000), sink1)).toContain("change it");
    expect(sink1.map((r) => r.rev)).toEqual([1]);
    const d2 = repo(hdr1), sink2: IntentRevision[] = [], f = join(d2, ".loki", "intent-revisions.jsonl");
    writeFileSync(f, "{\"rev\":4}\n"); chmodSync(f, 0);
    try { expect(consumeSteer(d2, process.env, () => new Date(5000), sink2)).toContain("change it"); } finally { chmodSync(f, 0o600); }
    expect(sink2.map((r) => r.rev)).toEqual([1]);
  });
  test("staleAtSeal consumes a steer still pending and counts it stale even with no Wall in the timeline", () => {
    const d = repo("## Operator directive rev 1 (2026-10-15T00:00:01Z) actor=alice source=chat\nlate\n");
    const ctx: { intentRevisions?: IntentRevision[]; timeline?: { stage: string; startMs: number }[] } = { timeline: [] };
    expect(staleAtSeal(d, ctx).map((r) => r.rev)).toEqual([1]);
    expect(ctx.intentRevisions?.map((r) => r.rev)).toEqual([1]);
    expect(staleAtSeal(d, ctx)).toEqual([]); // nothing pending any more, and no Wall
  });
  test("readIntentRevisions (status comment count) skips torn lines and earlier runs", () => {
    const d = repo();
    const row = (rev: number, at: number): string => JSON.stringify({ rev, actor: "a", source: "cli", sha256: "f".repeat(64), consumed_at: new Date(at).toISOString() });
    writeFileSync(join(d, ".loki", "intent-revisions.jsonl"), `${row(1, 100)}\n{torn\n${row(2, 5000)}\n`);
    expect(readIntentRevisions(d, 1000).map((r) => r.rev)).toEqual([2]);
  });
});
