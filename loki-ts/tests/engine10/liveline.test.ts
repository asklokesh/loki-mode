// D82: quiet-mode live status line.
import { describe, expect, test } from "bun:test";
import { LiveLine } from "../../src/engine10/output.ts";

const ev = (type: string, stage: string | null, data: Record<string, unknown> = {}) => ({ type, stage, data });
function rig(tty: boolean) {
  let t = 1_000_000; const out: string[] = [];
  const l = new LiveLine({ tty, write: (s) => out.push(s), now: () => t, columns: 100, graceS: 3 });
  return { l, out, adv: (s: number) => { t += s * 1000; } };
}

describe("LiveLine (D82)", () => {
  test("TTY rewrites one line in place, appends the URL, clears at the end", () => {
    const { l, out, adv } = rig(true);
    l.onEvent(ev("stage.started", "plan")); adv(14);
    l.onEvent(ev("stage.completed", "plan", { duration_s: 14 }));
    l.onEvent(ev("stage.started", "wall")); adv(62); l.tick();
    expect(out.every((s) => s.startsWith("\r\x1b[2K") && !s.includes("\n"))).toBe(true);
    expect(out.at(-1)).toContain("[wall] writing acceptance checks  1m02s  (plan done 14s)");
    l.setUrl("http://127.0.0.1:57374/");
    expect(out.at(-1)).toContain("(plan done 14s)  http://127.0.0.1:57374/");
    l.clear();
    expect(out.at(-1)).toBe("\r\x1b[2K");
    const n = out.length; l.tick(); l.onEvent(ev("stage.started", "verify"));
    expect(out.length).toBe(n);
  });
  test("non-TTY prints one plain line per slow stage, none for fast stages, no CR", () => {
    const { l, out, adv } = rig(false);
    l.onEvent(ev("stage.started", "intake")); adv(1); l.onEvent(ev("stage.completed", "intake", { duration_s: 1 }));
    l.onEvent(ev("stage.started", "plan")); adv(4); l.tick(); l.tick(); adv(10); l.tick();
    l.onEvent(ev("stage.completed", "plan", { duration_s: 14 }));
    l.onEvent(ev("stage.started", "wall")); adv(5); l.tick();
    l.clear();
    expect(out.length).toBe(2);
    expect(out.join("")).not.toMatch(/[\r\x1b]/);
    expect(out[0]).toContain("[plan] planning  4s");
    expect(out[1]).toContain("[wall] writing acceptance checks  5s  (plan done 14s)");
  });
});
