// Operator steer on engine10: HUMAN_INPUT.md is injected into the next plan/implement brief once, then archived.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINISH_LINE } from "../../src/e10ext/context.ts";
import { STEER_BEGIN, STEER_END, consumeSteer, withSteer } from "../../src/util/steer.ts";

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
});
