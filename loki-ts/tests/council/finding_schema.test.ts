// loki-ts/tests/council/finding_schema.test.ts -- Phase C (v7.5.20) tests.
//
// Covers:
//   - FINDING_SCHEMA loads from the static JSON file
//   - validateFinding accepts a conformant finding and returns AgentVerdict
//   - validateFinding rejects invalid vote enum / missing required / OOR confidence
//   - parseMultiResponse extracts JSON from prose-wrapped text
//   - parseMultiResponse throws on malformed JSON
//   - parseMultiResponse propagates per-finding validation errors

import { describe, it, expect } from "bun:test";
import {
  FINDING_SCHEMA,
  validateFinding,
  parseMultiResponse,
  hasFileLineAnchor,
  UNANCHORED_TAG,
} from "../../src/council/finding_schema.ts";

describe("FINDING_SCHEMA", () => {
  it("loads the static JSON schema with the documented top-level shape", () => {
    expect(FINDING_SCHEMA["type"]).toBe("object");
    const props = FINDING_SCHEMA["properties"] as Record<string, unknown>;
    expect(props["findings"]).toBeDefined();
    const required = FINDING_SCHEMA["required"] as string[];
    expect(required).toContain("findings");
  });
});

describe("validateFinding", () => {
  it("accepts a fully-specified valid finding and returns AgentVerdict", () => {
    const r = validateFinding({
      role: "requirements-verifier",
      vote: "APPROVE",
      reason: "all requirements satisfied",
      confidence: 0.9,
      severity: "LOW",
      suggested_action: "ship it",
      issues: [],
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return; // narrow
    expect(r.role).toBe("requirements-verifier");
    expect(r.verdict).toBe("APPROVE");
    expect(r.reason).toBe("all requirements satisfied");
    expect(r.issues).toEqual([]);
  });

  it("accepts a minimal finding (only required fields)", () => {
    const r = validateFinding({
      role: "test-auditor",
      vote: "REJECT",
      reason: "tests failing",
      confidence: 0.75,
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.verdict).toBe("REJECT");
    expect(r.issues).toEqual([]);
  });

  it("rejects an invalid vote enum value", () => {
    const r = validateFinding({
      role: "x",
      vote: "MAYBE",
      reason: "?",
      confidence: 0.5,
    });
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.path).toBe("$.vote");
    expect(r.error).toContain("APPROVE");
  });

  it("rejects a finding with missing required field (no reason)", () => {
    const r = validateFinding({
      role: "x",
      vote: "APPROVE",
      confidence: 0.5,
    });
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.path).toBe("$.reason");
  });

  it("rejects confidence out of range", () => {
    const r = validateFinding({
      role: "x",
      vote: "APPROVE",
      reason: "ok",
      confidence: 1.5,
    });
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.path).toBe("$.confidence");
    expect(r.error).toContain("[0,1]");
  });

  it("maps optional issues array onto AgentVerdict.issues", () => {
    const r = validateFinding({
      role: "x",
      vote: "REJECT",
      reason: "found issues",
      confidence: 0.8,
      issues: [
        { severity: "HIGH", description: "blocking at src/a.ts:42" },
        { severity: "LOW", description: "nit" },
      ],
    });
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.issues.length).toBe(2);
    expect(r.issues[0]?.severity).toBe("HIGH");
    expect(r.issues[1]?.description).toBe("nit");
  });
});

describe("parseMultiResponse", () => {
  it("parses a clean multi-finding response with 3 voters", () => {
    const text = JSON.stringify({
      findings: [
        { role: "requirements-verifier", vote: "APPROVE", reason: "ok", confidence: 0.9 },
        { role: "test-auditor", vote: "APPROVE", reason: "ok", confidence: 0.8 },
        { role: "convergence-voter", vote: "APPROVE", reason: "ok", confidence: 0.7 },
      ],
    });
    const out = parseMultiResponse(text);
    expect(out.length).toBe(3);
    expect(out[0]?.role).toBe("requirements-verifier");
    expect(out[2]?.verdict).toBe("APPROVE");
  });

  it("extracts JSON from a prose-wrapped response", () => {
    const text = `Here is my response:\n\n${JSON.stringify({
      findings: [
        { role: "x", vote: "REJECT", reason: "no", confidence: 0.5 },
      ],
    })}\n\nDone.`;
    const out = parseMultiResponse(text);
    expect(out.length).toBe(1);
    expect(out[0]?.verdict).toBe("REJECT");
  });

  it("throws on malformed JSON", () => {
    expect(() => parseMultiResponse("not { really json")).toThrow();
  });

  it("throws when findings array is missing", () => {
    expect(() => parseMultiResponse(JSON.stringify({ results: [] }))).toThrow(/findings/);
  });

  it("throws on empty findings array", () => {
    expect(() => parseMultiResponse(JSON.stringify({ findings: [] }))).toThrow(/non-empty/);
  });

  it("propagates per-finding validation errors", () => {
    const text = JSON.stringify({
      findings: [
        { role: "ok", vote: "APPROVE", reason: "ok", confidence: 0.5 },
        { role: "bad", vote: "MAYBE", reason: "ok", confidence: 0.5 },
      ],
    });
    expect(() => parseMultiResponse(text)).toThrow(/findings\[1\]/);
  });

  it("blocking finding without anchor is downgraded, not rejected", () => {
    for (const severity of ["CRITICAL", "HIGH"]) {
      const r = validateFinding({
        role: "devils_advocate",
        vote: "REJECT",
        reason: "bad",
        confidence: 0.8,
        issues: [{ severity, description: "this is broken somewhere" }],
      });
      expect("error" in r).toBe(false);
      if ("error" in r) return;
      expect(r.verdict).toBe("REJECT");
      expect(r.issues[0]?.severity).toBe("MEDIUM");
      expect(r.issues[0]?.description.startsWith(UNANCHORED_TAG)).toBe(true);
    }
  });

  it("anchored blocking issue and unanchored LOW keep their severity", () => {
    const r = validateFinding({
      role: "x",
      vote: "REJECT",
      reason: "bad",
      confidence: 0.8,
      issues: [
        { severity: "CRITICAL", description: "null deref at loki-ts/src/foo.ts:128" },
        { severity: "LOW", description: "nit without anchor" },
      ],
    });
    if ("error" in r) throw new Error(r.error);
    expect(r.issues.map((i) => i.severity)).toEqual(["CRITICAL", "LOW"]);
  });

  it("evidence roles are exempt from the anchor rule", () => {
    for (const role of ["requirements-verifier", "test-auditor", "convergence-voter"]) {
      const r = validateFinding({
        role,
        vote: "REJECT",
        reason: "bad",
        confidence: 0.8,
        issues: [{ severity: "HIGH", description: "missing requirement" }],
      });
      if ("error" in r) throw new Error(r.error);
      expect(r.issues[0]?.severity).toBe("HIGH");
    }
  });

  it("an unanchored HIGH does not drop the other verdicts", () => {
    const out = parseMultiResponse(
      JSON.stringify({
        findings: [
          { role: "a", vote: "APPROVE", reason: "ok", confidence: 0.9 },
          {
            role: "b",
            vote: "REJECT",
            reason: "bad",
            confidence: 0.7,
            issues: [{ severity: "HIGH", description: "vague" }],
          },
        ],
      }),
    );
    expect(out.length).toBe(2);
    expect(out[1]?.verdict).toBe("REJECT");
  });
});

describe("hasFileLineAnchor", () => {
  const yes = [
    "src/a.ts:42",
    "Makefile:12",
    "Dockerfile:3",
    "see `a.ts`:5 here",
    "a.ts:L42",
    "a.ts#L42",
    "a.ts (line 42)",
    "x (no file)",
    "http://x.com:80/ and src/b.py:7",
  ];
  const no = ["http://x.com:80/", "a.ts:0", "just words", "a.ts"];
  for (const d of yes) it(`accepts ${d}`, () => expect(hasFileLineAnchor(d)).toBe(true));
  for (const d of no) it(`rejects ${d}`, () => expect(hasFileLineAnchor(d)).toBe(false));
});
