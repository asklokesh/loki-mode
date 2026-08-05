// v8.x structured code-review: prove the TS re-materializer is byte-identical to
// the bash one (autonomy/lib/cr-rematerialize.py) and drives the UNCHANGED
// parseVerdict / countNonBlockingFindings to the correct decision. Pure, no
// subprocess, no billable agent. Mirrors tests/test-code-review-json-rematerialize.sh.
import { describe, expect, test } from "bun:test";
import {
  countNonBlockingFindings,
  parseVerdict,
  rematerializeCodeReview,
} from "../../src/runner/quality_gates.ts";

const env = (verdict: string, findings: Array<{ severity: string; description: string }>) =>
  JSON.stringify({ stop_reason: "tool_use", structured_output: { verdict, findings } });

describe("rematerializeCodeReview (v8.x structured verdict adapter)", () => {
  test("FAIL + Critical -> blocking FAIL", () => {
    const text = rematerializeCodeReview(env("FAIL", [{ severity: "Critical", description: "SQLi (a.py:10)" }]));
    expect(text).toBe("VERDICT: FAIL\nFINDINGS:\n- [Critical] SQLi (a.py:10)\n");
    const v = parseVerdict("r", text!);
    expect(v.verdict).toBe("FAIL");
    expect(v.blocking).toBe(true);
  });

  test("PASS + empty -> PASS, - None, non-blocking, 0/0", () => {
    const text = rematerializeCodeReview(env("PASS", []));
    expect(text).toBe("VERDICT: PASS\nFINDINGS:\n- None\n");
    const v = parseVerdict("r", text!);
    expect(v.verdict).toBe("PASS");
    expect(v.blocking).toBe(false);
    expect(countNonBlockingFindings(text!)).toEqual({ medium: 0, low: 0 });
  });

  test("FAIL + Medium + Low -> non-blocking, counts 1/1", () => {
    const text = rematerializeCodeReview(
      env("FAIL", [
        { severity: "Medium", description: "m" },
        { severity: "Low", description: "l" },
      ]),
    );
    const v = parseVerdict("r", text!);
    expect(v.verdict).toBe("FAIL");
    expect(v.blocking).toBe(false);
    expect(countNonBlockingFindings(text!)).toEqual({ medium: 1, low: 1 });
  });

  test("result-string fallback (no structured_output key)", () => {
    const raw = JSON.stringify({
      stop_reason: "tool_use",
      result: JSON.stringify({ verdict: "PASS", findings: [] }),
    });
    const text = rematerializeCodeReview(raw);
    expect(text).toBe("VERDICT: PASS\nFINDINGS:\n- None\n");
  });

  // T1: the fake-green guard. A self-contradictory PASS + Critical/High MUST
  // become a blocking FAIL, matching the python re-materializer.
  test("T1: PASS + Critical is FORCED to blocking FAIL", () => {
    const text = rematerializeCodeReview(env("PASS", [{ severity: "Critical", description: "SQLi" }]));
    const v = parseVerdict("r", text!);
    expect(v.verdict).toBe("FAIL");
    expect(v.blocking).toBe(true);
  });

  test("T1: PASS + High is FORCED to blocking FAIL", () => {
    const text = rematerializeCodeReview(env("PASS", [{ severity: "High", description: "authz bypass" }]));
    const v = parseVerdict("r", text!);
    expect(v.verdict).toBe("FAIL");
    expect(v.blocking).toBe(true);
  });

  // Fail-closed: every malformed envelope returns null (caller emits synthetic FAIL).
  test.each([
    ["not json at all", "not json at all"],
    ["missing verdict", JSON.stringify({ stop_reason: "tool_use", structured_output: { findings: [] } })],
    ["wrong stop_reason", JSON.stringify({ stop_reason: "refusal", structured_output: { verdict: "PASS", findings: [] } })],
    ["invalid verdict token", JSON.stringify({ stop_reason: "tool_use", structured_output: { verdict: "MAYBE", findings: [] } })],
  ])("fail-closed: %s -> null", (_label, raw) => {
    expect(rematerializeCodeReview(raw)).toBeNull();
  });

  // Recorded-real envelope (locks the field contract to live CLI 2.1.207 output).
  test("recorded-real envelope -> blocking FAIL", () => {
    const real =
      '{"stop_reason":"tool_use","structured_output":{"verdict":"FAIL","findings":[{"severity":"Critical","description":"SQL injection vulnerability (db.py:10)"}]},"result":"{\\"verdict\\":\\"FAIL\\",\\"findings\\":[{\\"severity\\":\\"Critical\\",\\"description\\":\\"SQL injection vulnerability (db.py:10)\\"}]}"}';
    const v = parseVerdict("r", rematerializeCodeReview(real)!);
    expect(v.verdict).toBe("FAIL");
    expect(v.blocking).toBe(true);
  });
});

// v8 raw-SDK reviewer path: `loki internal sdk-judge` (and the in-process
// judgeJson) emit the BARE payload object -- no CLI envelope. The re-materializer
// must accept it and produce output byte-identical to the wrapped form, with the
// T1 override and fail-closed guarantees intact. Mirrors the python edit.
describe("rematerializeCodeReview (v8 raw-SDK bare-object path)", () => {
  // bare = the object the SDK bridge emits (no stop_reason / structured_output).
  const bare = (verdict: string, findings: Array<{ severity: string; description: string }>) =>
    JSON.stringify({ verdict, findings });

  test("bare PASS + empty == wrapped PASS + empty (byte-identical)", () => {
    const wrapped = rematerializeCodeReview(env("PASS", []));
    const b = rematerializeCodeReview(bare("PASS", []));
    expect(b).toBe("VERDICT: PASS\nFINDINGS:\n- None\n");
    expect(b).toBe(wrapped);
  });

  test("bare FAIL + Critical -> blocking FAIL (parity with envelope)", () => {
    const text = rematerializeCodeReview(bare("FAIL", [{ severity: "Critical", description: "SQLi (a.py:10)" }]));
    expect(text).toBe("VERDICT: FAIL\nFINDINGS:\n- [Critical] SQLi (a.py:10)\n");
    const v = parseVerdict("r", text!);
    expect(v.verdict).toBe("FAIL");
    expect(v.blocking).toBe(true);
  });

  // T1 must hold through the bare path too: a self-contradictory PASS + High
  // becomes blocking FAIL, never a fake green.
  test("T1: bare PASS + High is FORCED to blocking FAIL", () => {
    const text = rematerializeCodeReview(bare("PASS", [{ severity: "High", description: "authz bypass" }]));
    const v = parseVerdict("r", text!);
    expect(v.verdict).toBe("FAIL");
    expect(v.blocking).toBe(true);
  });

  // Fail-closed still holds for a bare object: no verdict key -> null; invalid
  // token -> null. (A bare {"foo":"bar"} must NOT sneak through as the payload.)
  test.each([
    ["bare no verdict", JSON.stringify({ foo: "bar", findings: [] })],
    ["bare invalid verdict token", JSON.stringify({ verdict: "MAYBE", findings: [] })],
  ])("fail-closed: %s -> null", (_label, raw) => {
    expect(rematerializeCodeReview(raw)).toBeNull();
  });
});
