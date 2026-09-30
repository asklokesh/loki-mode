// S41-05 Wall check (docs/v10/SCORECARD-PLAN.md section 4, docs/v10/DECISIONS.md D42 (1)).
// One test per rank key, per disqualifier, early accept, and "attempt-authored test ignored".
import { describe, expect, it } from "bun:test";
import { isEarlyAccept, selectAttempt, type AttemptCandidate, type AttemptCheck } from "../../src/e10ext/select.ts";
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

  it("M4: a flaky result is never a deterministic fail, so it costs only key 4, not key 2", () => {
    // localS has two independent tests so the "real fail" comparison (test_x) is untouched by
    // the flaky one (test_y). a: test_x not_run (0 det fails), test_y flaky (1 flaky, 0 det
    // fails if flaky is correctly excluded from the count). b: test_x is a REAL fail (1 det
    // fail), test_y not_run (0 flaky). Correct: a wins on key 2 (0 det fails < 1). If flaky were
    // miscounted as a deterministic fail, a's count would rise to 1, tying b's key 2, and key 4
    // (a has 1 flaky, b has 0) would then hand it to b instead.
    const localS: TestRef[] = [
      { runner: "pytest", path: "tests/test_x.py" },
      { runner: "pytest", path: "tests/test_y.py" },
    ];
    const a = attempt(0, [check("pytest:tests/test_x.py", "not_run"), check("pytest:tests/test_y.py", "flaky")]);
    const b = attempt(1, [check("pytest:tests/test_x.py", "fail"), check("pytest:tests/test_y.py", "not_run")]);
    expect(selectAttempt([a, b], localS, []).index).toBe(0);
  });
});

describe("selectAttempt: R1, a Wall test outside S", () => {
  it("reviewer probe: an attempt that fails the Wall must never win because S was built without that Wall test", () => {
    // Wall files are written after baseSha and left uncommitted (wall.ts), and S is filtered to
    // "tests that exist at baseSha" (section 4), so a real caller can build S without the Wall
    // test in it. a fails the Wall test but passes both S tests; b passes the Wall test, passes
    // one S test and fails the other. b must win on key 1 (Wall passes) before key 2 is even
    // reached, regardless of a's cleaner S-based record.
    const localS: TestRef[] = [
      { runner: "pytest", path: "tests/test_b.py" },
      { runner: "pytest", path: "tests/test_c.py" },
    ];
    const localWall: TestRef[] = [{ runner: "pytest", path: "tests/test_wall.py" }];
    const a = attempt(0, [
      check("pytest:tests/test_wall.py", "fail"),
      check("pytest:tests/test_b.py", "pass"),
      check("pytest:tests/test_c.py", "pass"),
    ]);
    const b = attempt(1, [
      check("pytest:tests/test_wall.py", "pass"),
      check("pytest:tests/test_b.py", "pass"),
      check("pytest:tests/test_c.py", "fail"),
    ]);
    const r = selectAttempt([a, b], localS, localWall);
    expect(r.index).toBe(1);
    expect(r.reason).toBe("rank: wallPasses");
  });

  it("M1' does not leak a Wall-outside-S check into the S-based counts (keys 2-4)", () => {
    // test_wall is in wall but not in S. a fails it, b leaves it not_run: under the fix, neither
    // counts toward deterministicFails (only wallPasses would move, and here both wallPasses tie
    // at 0 since neither passed it), so a and b tie on every S-based key too and the lower index
    // (a) wins on the index tie-break. Mutation M1' (`if (!inS && !wallNames.has(c.name))
    // continue`, replacing the sole S gate) would let a's test_wall "fail" leak into
    // deterministicFails, giving a 1 fail versus b's 0 and flipping the winner to b.
    const localS: TestRef[] = [{ runner: "pytest", path: "tests/test_b.py" }];
    const localWall: TestRef[] = [{ runner: "pytest", path: "tests/test_wall.py" }];
    const a = attempt(0, [check("pytest:tests/test_wall.py", "fail"), check("pytest:tests/test_b.py", "pass")]);
    const b = attempt(1, [check("pytest:tests/test_wall.py", "not_run"), check("pytest:tests/test_b.py", "pass")]);
    const r = selectAttempt([a, b], localS, localWall);
    expect(r.index).toBe(0);
    expect(r.reason).toBe("rank: index");
  });
});

describe("selectAttempt: rank key adjacency (a swapped key order must flip the winner)", () => {
  it("M3: keys 1 and 2 are not interchangeable -- more Wall passes wins even with more deterministic fails", () => {
    // a: 1 Wall pass (via a system-interpreter check, so it can't also feed passesInS) and 1 real
    // deterministic fail. b: 0 Wall passes, 0 deterministic fails. Key 1 (Wall passes) is primary,
    // so a wins despite being worse on key 2; swapping keys 1 and 2 would let b's clean key-2
    // record decide first and flip the winner to b.
    const a = attempt(0, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "fail"),
    ]);
    const b = attempt(1, [check("pytest:tests/test_a.py", "not_run"), check("pytest:tests/test_b.py", "not_run")]);
    expect(selectAttempt([a, b], S, WALL).index).toBe(0);
  });

  it("M2: keys 3 and 4 are not interchangeable -- more S passes wins even with more flaky checks", () => {
    // a: 2 project-interpreter passes and 1 flaky (in a third S test). b: 1 pass, 0 flaky. Key 3
    // (S passes) is primary over key 4 (flaky count), so a wins despite being worse on key 4;
    // swapping keys 3 and 4 would let b's zero-flaky record decide first and flip the winner to b.
    const localS: TestRef[] = [
      { runner: "pytest", path: "tests/test_a.py" },
      { runner: "pytest", path: "tests/test_b.py" },
      { runner: "pytest", path: "tests/test_c.py" },
    ];
    const a = attempt(0, [
      check("pytest:tests/test_a.py", "pass"),
      check("pytest:tests/test_b.py", "pass"),
      check("pytest:tests/test_c.py", "flaky"),
    ]);
    const b = attempt(1, [
      check("pytest:tests/test_a.py", "pass"),
      check("pytest:tests/test_b.py", "not_run"),
      check("pytest:tests/test_c.py", "not_run"),
    ]);
    expect(selectAttempt([a, b], localS, []).index).toBe(0);
  });

  it("2-3: keys 2 and 3 are not interchangeable -- fewer deterministic fails wins even with fewer S passes", () => {
    // a: 0 deterministic fails, 0 S passes. b: 1 deterministic fail, 2 S passes. No wall checks
    // involved (wallPasses ties at 0 for both). Key 2 (fewer fails) is primary over key 3 (more
    // passes), so a wins despite having fewer passes; swapping keys 2 and 3 would let b's larger
    // pass count decide first and flip the winner to b.
    const localS: TestRef[] = [
      { runner: "pytest", path: "tests/test_a.py" },
      { runner: "pytest", path: "tests/test_b.py" },
      { runner: "pytest", path: "tests/test_c.py" },
    ];
    const a = attempt(0, [
      check("pytest:tests/test_a.py", "not_run"),
      check("pytest:tests/test_b.py", "not_run"),
      check("pytest:tests/test_c.py", "not_run"),
    ]);
    const b = attempt(1, [
      check("pytest:tests/test_a.py", "fail"),
      check("pytest:tests/test_b.py", "pass"),
      check("pytest:tests/test_c.py", "pass"),
    ]);
    expect(selectAttempt([a, b], localS, []).index).toBe(0);
  });

  it("4-5: keys 4 and 5 are not interchangeable -- fewer flaky checks wins even with more lint fails", () => {
    // a: 0 flaky, 1 lint fail. b: 1 flaky, 0 lint fails. No S/wall checks differ (both not_run,
    // tying keys 1-3 at 0). Key 4 (flaky) is primary over key 5 (lint), so a wins despite the lint
    // fail; swapping keys 4 and 5 would let b's clean lint record decide first and flip the winner.
    const localS: TestRef[] = [{ runner: "pytest", path: "tests/test_a.py" }];
    const a = attempt(0, [check("pytest:tests/test_a.py", "not_run"), check("lint:ruff", "fail")]);
    const b = attempt(1, [check("pytest:tests/test_a.py", "flaky"), check("lint:ruff", "pass")]);
    expect(selectAttempt([a, b], localS, []).index).toBe(0);
  });

  it("5-6: keys 5 and 6 are not interchangeable -- fewer lint fails wins even with a larger diff", () => {
    // a: 0 lint fails, a 3-line diff. b: 1 lint fail, a 1-line diff. Every check-based key ties
    // (both have one not_run S check, no wall). Key 5 (lint) is primary over key 6 (diff size),
    // so a wins despite the larger diff; swapping keys 5 and 6 would let b's smaller diff decide
    // first and flip the winner to b.
    const localS: TestRef[] = [{ runner: "pytest", path: "tests/test_a.py" }];
    const checks = [check("pytest:tests/test_a.py", "not_run")];
    const a = attempt(0, [...checks, check("lint:ruff", "pass")], { diff: "+1\n+2\n+3\n" });
    const b = attempt(1, [...checks, check("lint:ruff", "fail")], { diff: "+1\n" });
    expect(selectAttempt([a, b], localS, []).index).toBe(0);
  });

  it("6-7: keys 6 and 7 are not interchangeable -- a smaller diff wins even at a higher attempt index", () => {
    // a (index 0): a 3-line diff. b (index 1): a 1-line diff. Every check-based key ties. Key 6
    // (diff size) is primary over key 7 (index), so b wins despite the higher index; swapping
    // keys 6 and 7 would let the lower index decide first and flip the winner to a.
    const localS: TestRef[] = [{ runner: "pytest", path: "tests/test_a.py" }];
    const checks = [check("pytest:tests/test_a.py", "not_run")];
    const a = attempt(0, checks, { diff: "+1\n+2\n+3\n" });
    const b = attempt(1, checks, { diff: "+1\n" });
    expect(selectAttempt([a, b], localS, []).index).toBe(1);
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
    expect(r.reason).toContain("index 0");
  });

  it("N2: when only B is given and it's disqualified, the reason names B's own index, not 'A'", () => {
    // Only one attempt was passed in at all, and its index is 1 ("B"). The fallback keeps it
    // (it's the only, hence lowest-index, attempt available) but must not claim "keeping A".
    const b = attempt(1, [], { killedOrErrored: true });
    const r = selectAttempt([b], S, WALL);
    expect(r.index).toBe(1);
    expect(r.reason).not.toMatch(/keeping A\b/);
    expect(r.reason).toContain("index 1");
  });
});

describe("selectAttempt: early accept", () => {
  it("selectAttempt still returns the one finished attempt when every S and Wall check passes", () => {
    const a = attempt(0, [check("pytest:tests/test_a.py", "pass"), check("pytest:tests/test_b.py", "pass")]);
    expect(selectAttempt([a], S, WALL).index).toBe(0);
  });

  it("selectAttempt is NOT early accept: called with one all-failing attempt it still returns it", () => {
    // This is what the misleading old comment on selectAttempt got wrong: a single finished
    // attempt does not imply every check passed. The caller must check isEarlyAccept itself.
    const a = attempt(0, [check("pytest:tests/test_a.py", "fail"), check("pytest:tests/test_b.py", "fail")]);
    expect(selectAttempt([a], S, WALL).index).toBe(0);
    expect(isEarlyAccept(a, S, WALL)).toBe(false);
  });
});

describe("isEarlyAccept", () => {
  it("is true only when S is non-empty and every S and Wall check passed", () => {
    const a = attempt(0, [check("pytest:tests/test_a.py", "pass"), check("pytest:tests/test_b.py", "pass")]);
    expect(isEarlyAccept(a, S, WALL)).toBe(true);
  });

  it("is false when S is empty, even if every check present passes", () => {
    const a = attempt(0, [check("pytest:tests/test_a.py", "pass")]);
    expect(isEarlyAccept(a, [], [])).toBe(false);
  });

  it("is false when any S or Wall check is missing a pass (not_run, flaky, or absent)", () => {
    const notRun = attempt(0, [check("pytest:tests/test_a.py", "pass"), check("pytest:tests/test_b.py", "not_run")]);
    const missing = attempt(1, [check("pytest:tests/test_a.py", "pass")]);
    expect(isEarlyAccept(notRun, S, WALL)).toBe(false);
    expect(isEarlyAccept(missing, S, WALL)).toBe(false);
  });

  it("is false for an all-fail attempt (must go red against a stub that always returns true)", () => {
    const allFail = attempt(0, [check("pytest:tests/test_a.py", "fail"), check("pytest:tests/test_b.py", "fail")]);
    expect(isEarlyAccept(allFail, S, WALL)).toBe(false);
  });

  it("B2: is false when a Wall check outside S fails, even though every S check passes", () => {
    const wallOnly: TestRef[] = [{ runner: "pytest", path: "tests/test_wall.py" }];
    const a = attempt(0, [check("pytest:tests/test_b.py", "pass"), check("pytest:tests/test_wall.py", "fail")]);
    expect(isEarlyAccept(a, [S[1]!], wallOnly)).toBe(false);
  });

  it("E3: is false when any S or Wall check is flaky, even though every other check passes", () => {
    const flakyOne = attempt(0, [check("pytest:tests/test_a.py", "pass"), check("pytest:tests/test_b.py", "flaky")]);
    expect(isEarlyAccept(flakyOne, S, WALL)).toBe(false);
  });
});

describe("selectAttempt: rank key 3 counts only project-interpreter passes (B3)", () => {
  it("a system-interpreter pass in S, outside the Wall, is not counted", () => {
    // Everything ties except b's system-interpreter pass of test_b (in S, not Wall). If it were
    // counted, b would win at key 3; uncounted, every key ties and index 0 wins.
    const a = attempt(0, [check("pytest:tests/test_a.py", "pass", { interpreter: "system" }), check("pytest:tests/test_b.py", "not_run")]);
    const b = attempt(1, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "pass", { interpreter: "system" }),
    ]);
    expect(selectAttempt([a, b], S, WALL).index).toBe(0);
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

  it("M1: a self-authored pass never counts even when it would otherwise win on every remaining key", () => {
    // a and b tie exactly on every real S/Wall check (both: 1 Wall pass via a system-interpreter
    // check, 1 project-interpreter pass), so only the index tie-break should decide and a
    // (index 0) wins. b additionally has a self-authored passing check (not in S, not in wall).
    // If that check were ever counted (M1: deleting the attempt-authored guard), it would raise
    // b's S-pass count above a's and hand key 3 -- and the whole decision -- to b instead.
    const a = attempt(0, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "pass"),
    ]);
    const b = attempt(1, [
      check("pytest:tests/test_a.py", "pass", { interpreter: "system" }),
      check("pytest:tests/test_b.py", "pass"),
      check("pytest:tests/test_self_authored.py", "pass"),
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
