// loki-ts/tests/engine10/escalate.test.ts
//
// E-29 wall check (docs/v10/ENGINE.md section 13 / section 16). decide() and
// apply() are pure/fake-friendly, so this needs none of E-02/E-16's real
// implementations -- same pattern as eta.test.ts and plan.test.ts.
import { describe, expect, test } from "bun:test";
import {
  apply,
  decide,
  ESCALATION_LABELS,
  PLAN_FILE_TRIGGER,
  REPO_FILE_TRIGGER,
} from "../../src/engine10/escalate.ts";
import { DEEP_CAP_S, DEEP_IMPLEMENT_LIMIT_S, DEFAULT_CAP_S, STAGE_BUDGETS } from "../../src/engine10/types.ts";
import type { EventEnvelope, EventType, StageName } from "../../src/engine10/types.ts";

function baseInput() {
  return { deepFlag: false, repoFileCount: 100, planFiles: [] as string[] };
}

describe("decide", () => {
  test("no trigger: the cap stays 900s (green criterion)", () => {
    const d = decide(baseInput());
    expect(d.escalate).toBe(false);
    expect(d.reason).toBeNull();
    expect(d.capS).toBe(DEFAULT_CAP_S);
    expect(d.capS).toBe(900);
    expect(d.implementLimitS).toBe(STAGE_BUDGETS.implement.limitS);
    expect(d.fullSuite).toBe(false);
  });

  test("a 13-file plan escalates (green criterion: > 12 files)", () => {
    const planFiles = Array.from({ length: 13 }, (_, i) => `file${i}.ts`);
    const d = decide({ ...baseInput(), planFiles });
    expect(d.escalate).toBe(true);
    expect(d.reason).toBe("plan-files");
    expect(d.capS).toBe(DEEP_CAP_S);
    expect(d.implementLimitS).toBe(DEEP_IMPLEMENT_LIMIT_S);
    expect(d.fullSuite).toBe(true);
  });

  test("exactly 12 files does not escalate (boundary: 'more than 12')", () => {
    const planFiles = Array.from({ length: PLAN_FILE_TRIGGER }, (_, i) => `file${i}.ts`);
    const d = decide({ ...baseInput(), planFiles });
    expect(d.escalate).toBe(false);
  });

  test("--deep escalates regardless of repo size or plan", () => {
    const d = decide({ ...baseInput(), deepFlag: true });
    expect(d.escalate).toBe(true);
    expect(d.reason).toBe("deep-flag");
  });

  test("a repo over 20,000 tracked files escalates", () => {
    const d = decide({ ...baseInput(), repoFileCount: REPO_FILE_TRIGGER + 1 });
    expect(d.escalate).toBe(true);
    expect(d.reason).toBe("repo-size");
  });

  test("exactly 20,000 tracked files does not escalate (boundary: 'more than')", () => {
    const d = decide({ ...baseInput(), repoFileCount: REPO_FILE_TRIGGER });
    expect(d.escalate).toBe(false);
  });

  test("an 'epic' issue label escalates", () => {
    const d = decide({ ...baseInput(), issueLabels: ["epic"] });
    expect(d.escalate).toBe(true);
    expect(d.reason).toBe("issue-label");
  });

  test("a 'large' issue label escalates, case-insensitively", () => {
    const d = decide({ ...baseInput(), issueLabels: ["Large"] });
    expect(d.escalate).toBe(true);
    expect(d.reason).toBe("issue-label");
  });

  test("an unrelated issue label does not escalate", () => {
    const d = decide({ ...baseInput(), issueLabels: ["bug", "docs"] });
    expect(d.escalate).toBe(false);
  });

  test("ESCALATION_LABELS names exactly epic and large", () => {
    expect([...ESCALATION_LABELS].sort()).toEqual(["epic", "large"]);
  });
});

describe("apply", () => {
  function fakeEmit(): { calls: { type: EventType; stage: StageName | null; data: Record<string, unknown> }[]; emit: (t: EventType, s: StageName | null, d: Record<string, unknown>) => void } {
    const calls: { type: EventType; stage: StageName | null; data: Record<string, unknown> }[] = [];
    return { calls, emit: (type, stage, data) => calls.push({ type, stage, data }) };
  }

  test("logs an `escalated` event when a trigger holds (green criterion)", () => {
    const { calls, emit } = fakeEmit();
    const planFiles = Array.from({ length: 13 }, (_, i) => `file${i}.ts`);
    const decision = apply({ emit }, { ...baseInput(), planFiles });

    expect(decision.escalate).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.type).toBe("escalated");
    expect(calls[0]!.stage).toBeNull();
    expect(calls[0]!.data).toMatchObject({
      reason: "plan-files",
      cap_s: DEEP_CAP_S,
      implement_limit_s: DEEP_IMPLEMENT_LIMIT_S,
    });
  });

  test("emits nothing without a trigger", () => {
    const { calls, emit } = fakeEmit();
    const decision = apply({ emit }, baseInput());
    expect(decision.escalate).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("the emitted event folds the same way events.ts already expects (section 5)", () => {
    // events.test.ts already exercises fold() reading `escalated` events shaped
    // { reason } at stage=null; this only pins that apply() emits that shape.
    const { calls, emit } = fakeEmit();
    apply({ emit }, { ...baseInput(), deepFlag: true });
    const env: Pick<EventEnvelope, "type" | "stage" | "data"> = {
      type: calls[0]!.type,
      stage: calls[0]!.stage,
      data: calls[0]!.data,
    };
    expect(env.type).toBe("escalated");
    expect(env.stage).toBeNull();
    expect(typeof env.data.reason).toBe("string");
  });
});
