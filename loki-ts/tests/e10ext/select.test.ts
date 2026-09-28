// S41-05 Wall check (docs/v10/SCORECARD-PLAN.md section 4, docs/v10/DECISIONS.md D42 (1)).
// One test per rank key, per disqualifier, early accept, and "attempt-authored test ignored".
import { describe, expect, it } from "bun:test";
import { selectAttempt, type AttemptCandidate, type AttemptCheck } from "../../src/e10ext/select.ts";
import type { TestRef } from "../../src/engine10/types.ts";

const S: TestRef[] = [
  { runner: "pytest", path: "tests/test_a.py" },
  { runner: "pytest", path: "tests/test_b.py" },
];
const WALL: TestRef[] = [{ runner: "pytest", path: "tests/test_a.py" }];

function check(name: string, result: AttemptCheck["result"], extra: Partial<AttemptCheck> = {}): AttemptCheck {
  return { name, cmd: "pytest -q " + name, result, duration_s: 1, interpreter: "project", ...extra };
}

function attempt(index: number, checks: AttemptCheck[], extra: Partial<AttemptCandidate> = {}): AttemptCandidate {
  return {
    index,
    killedOrErrored: false,
    diff: "diff --git a/x b/x\n+line\n",
    alreadyDoneEvidence: false,
    weakensTest: false,
    checks,
    ...extra,
  };
}

describe("selectAttempt: rank key 1, Wall passes", () => {
  it("an attempt whose Wall tests all pass beats one with failures", () => {
    const a = attempt(0, [check("pytest:tests/test_a.py", "pass"), check("pytest:tests/test_b.py", "pass")]);
    const b = attempt(1, [check("pytest:tests/test_a.py", "fail"), check("pytest:tests/test_b.py", "pass")]);
    expect(selectAttempt([a, b], S, WALL).index).toBe(0);
  });

  it("decides purely on the wall-pass count, isolated from every later key (a system-interpreter wall pass still counts here, at key 1, even though it can't feed key 3)", () => {
    // Both attempts tie on deterministicFails/passesInS/flakyInS/lintFails/diffLines: neither
    // attempt has any check that is a *project*-interpreter pass or a fail. The lower-index
    // attempt (a, index 0) has no wall pass; the higher-index attempt (b, index 1) has one, on
    // the system interpreter, so it counts at key 1 but not at key 3. If key 1 is dropped from
    // the rank tuple, every key ties and the index tie-break wrongly hands this to a.
    const a = attempt(0, [check("pytest:tests/test_a.py", "not_run"), check("pytest:tests/test_b.py", "not_run")]);
    const b = attempt(1, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "not_run"),
    ]);
    expect(selectAttempt([a, b], S, WALL).index).toBe(1);
  });
});

// Every test below puts the intended winner at the HIGHER attempt index (index 1) and the
// intended loser at the lower index (index 0). That way, mutating out the key under test makes
// every remaining key (including the index 7 tie-break) tie or favor the loser, so the assertion
// goes red instead of accidentally re-passing through the tie-break (D42/loki-verify: a
// redundant path defeats mutation).

describe("selectAttempt: rank key 2, deterministic-fail count", () => {
  it("fewer deterministic fails wins when Wall passes and pass-count tie", () => {
    // Both: wallPasses=1 (test_a passes on both, interpreter=system so it never feeds passesInS),
    // passesInS=0, flakyInS=0, lintFails=0, equal diffs. Only b's test_b is a real fail.
    const a = attempt(0, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "fail"),
    ]);
    const b = attempt(1, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "not_run"),
    ]);
    expect(selectAttempt([a, b], S, WALL).index).toBe(1);
  });

  it("a pytest collection-error exit is excluded from the count (condition 5): the two attempts tie and index decides", () => {
    // If exit_code 2 counted as a deterministic fail, a would have one more than b and b (index 1)
    // would win on key 2; excluded, both tie all the way down and the lower index (a) wins. That
    // makes this test fail, not silently pass, if the exclusion is ever dropped.
    const a = attempt(0, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "fail", { exit_code: 2 }),
    ]);
    const b = attempt(1, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "not_run"),
    ]);
    expect(selectAttempt([a, b], S, WALL).index).toBe(0);
  });

  it("interpreter=system is excluded from the count (condition 3): the two attempts tie and index decides", () => {
    const a = attempt(0, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "fail", { interpreter: "system" }),
    ]);
    const b = attempt(1, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "not_run"),
    ]);
    expect(selectAttempt([a, b], S, WALL).index).toBe(0);
  });
});

describe("selectAttempt: rank key 3, pass count on the project interpreter", () => {
  it("more S passes on the project interpreter wins once earlier keys tie", () => {
    // Both: wallPasses=1 (test_a passes on both, interpreter=system so it feeds key 1 but not
    // key 3), 0 deterministic fails. Only b's test_b is a real project-interpreter pass.
    const a = attempt(0, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "not_run"),
    ]);
    const b = attempt(1, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "pass"),
    ]);
    expect(selectAttempt([a, b], S, WALL).index).toBe(1);
  });

  it("a not_run-heavy attempt ranks below a real pass and is never picked", () => {
    const notRun = attempt(0, [check("pytest:tests/test_a.py", "not_run"), check("pytest:tests/test_b.py", "not_run")]);
    const real = attempt(1, [check("pytest:tests/test_a.py", "pass"), check("pytest:tests/test_b.py", "pass")]);
    const r = selectAttempt([notRun, real], S, WALL);
    expect(r.index).toBe(1);
  });
});

describe("selectAttempt: rank key 4, flaky count", () => {
  it("fewer flaky checks wins once wall/fail/pass keys tie", () => {
    // Both: wallPasses=1 (system-interpreter, so it never feeds passesInS), 0 deterministic
    // fails, 0 passesInS. Only a's test_b is flaky.
    const a = attempt(0, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "flaky"),
    ]);
    const b = attempt(1, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "not_run"),
    ]);
    expect(selectAttempt([a, b], S, WALL).index).toBe(1);
  });
});

describe("selectAttempt: rank key 5, lint fails", () => {
  it("fewer lint failures wins once every test-based key ties", () => {
    const a = attempt(0, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "not_run"),
      check("lint:ruff", "fail"),
    ]);
    const b = attempt(1, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "not_run"),
      check("lint:ruff", "pass"),
    ]);
    expect(selectAttempt([a, b], S, WALL).index).toBe(1);
  });
});

describe("selectAttempt: rank key 6, diff size", () => {
  it("the smaller diff wins once every check-based key ties", () => {
    const checks = [check("pytest:tests/test_a.py", "pass", { interpreter: "system" }), check("pytest:tests/test_b.py", "not_run")];
    const a = attempt(0, checks, { diff: "+one\n+two\n+three\n" });
    const b = attempt(1, checks, { diff: "+one\n" });
    expect(selectAttempt([a, b], S, WALL).index).toBe(1);
  });
});

describe("selectAttempt: rank key 7, attempt index (the tie-break)", () => {
  it("picks the lower index when every other key ties exactly", () => {
    const checks = [check("pytest:tests/test_a.py", "pass"), check("pytest:tests/test_b.py", "pass")];
    const a = attempt(0, checks, { diff: "+same\n" });
    const b = attempt(1, checks, { diff: "+same\n" });
    const r = selectAttempt([b, a], S, WALL); // order in the array must not matter
    expect(r.index).toBe(0);
    expect(r.reason).toBe("rank: index");
  });
});

describe("selectAttempt: disqualifiers", () => {
  it("drops a killed or errored session", () => {
    const a = attempt(0, [check("pytest:tests/test_a.py", "fail")], { killedOrErrored: true });
    const b = attempt(1, [check("pytest:tests/test_a.py", "pass"), check("pytest:tests/test_b.py", "pass")]);
    expect(selectAttempt([a, b], S, WALL).index).toBe(1);
  });

  it("drops an empty diff without already_done evidence", () => {
    const a = attempt(0, [check("pytest:tests/test_a.py", "pass"), check("pytest:tests/test_b.py", "pass")], { diff: "  \n" });
    const b = attempt(1, [check("pytest:tests/test_a.py", "pass")]);
    expect(selectAttempt([a, b], S, WALL).index).toBe(1);
  });

  it("keeps an empty diff when already_done evidence is present", () => {
    const a = attempt(0, [check("pytest:tests/test_a.py", "pass"), check("pytest:tests/test_b.py", "pass")], {
      diff: "",
      alreadyDoneEvidence: true,
    });
    const b = attempt(1, [check("pytest:tests/test_a.py", "fail")]);
    expect(selectAttempt([a, b], S, WALL).index).toBe(0);
  });

  it("drops an attempt that weakens a test (seal.ts's weakened-test rule)", () => {
    const a = attempt(0, [check("pytest:tests/test_a.py", "pass"), check("pytest:tests/test_b.py", "pass")], { weakensTest: true });
    const b = attempt(1, [check("pytest:tests/test_a.py", "pass")]);
    expect(selectAttempt([a, b], S, WALL).index).toBe(1);
  });

  it("falls back to A when both attempts are disqualified", () => {
    const a = attempt(0, [], { killedOrErrored: true });
    const b = attempt(1, [], { weakensTest: true });
    const r = selectAttempt([b, a], S, WALL); // order must not matter: fallback is "keep A" (index 0)
    expect(r.index).toBe(0);
    expect(r.reason).toMatch(/fallback/);
  });
});

describe("selectAttempt: early accept", () => {
  it("accepts the one finished attempt when every S and Wall check passes, without waiting on a second", () => {
    const a = attempt(0, [check("pytest:tests/test_a.py", "pass"), check("pytest:tests/test_b.py", "pass")]);
    expect(selectAttempt([a], S, WALL).index).toBe(0);
  });
});

describe("selectAttempt: attempt-authored test ignored", () => {
  it("a check outside S and outside wall never counts toward ranking", () => {
    // b "wins" on an extra self-authored test it added and passed, but loses on the real S set.
    const a = attempt(0, [check("pytest:tests/test_a.py", "pass"), check("pytest:tests/test_b.py", "pass")]);
    const b = attempt(1, [
      check("pytest:tests/test_a.py", "fail"),
      check("pytest:tests/test_b.py", "not_run"),
      check("pytest:tests/test_new_self_authored.py", "pass"),
    ]);
    expect(selectAttempt([a, b], S, WALL).index).toBe(0);
  });
});

describe("selectAttempt: all attempts failing", () => {
  it("still ranks the least-bad attempt instead of throwing", () => {
    const a = attempt(0, [check("pytest:tests/test_a.py", "fail"), check("pytest:tests/test_b.py", "fail")]);
    const b = attempt(1, [
      check("pytest:tests/test_a.py", "fail"),
      check("pytest:tests/test_b.py", "fail"),
      check("lint:ruff", "fail"),
    ]);
    const r = selectAttempt([a, b], S, WALL);
    expect(r.index).toBe(0); // a has fewer lint fails once every test key ties at 2 deterministic fails
  });
});
