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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FINDING_SCHEMA,
  validateFinding,
  parseMultiResponse,
  hasFileLineAnchor,
  UNANCHORED_TAG,
  assertStaticSchema,
  normalizeEnumValue,
  SchemaLiteralError,
  resolveSchemaDataDir,
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

describe("#295 enum case normalization", () => {
  const base = { role: "r", reason: "ok", confidence: 0.5 };
  for (const sev of ["high", "High", "HIGH", " high "]) {
    it(`issue severity ${JSON.stringify(sev)} normalizes to HIGH`, () => {
      const r = validateFinding({ ...base, vote: "REJECT", issues: [{ severity: sev, description: "a.ts:1 broken" }] });
      expect("error" in r).toBe(false);
      expect((r as { issues: { severity: string }[] }).issues[0]!.severity).toBe("HIGH");
    });
  }
  it("vote case and separators normalize (approve, cannot-validate)", () => {
    expect((validateFinding({ ...base, vote: "approve" }) as { verdict: string }).verdict).toBe("APPROVE");
    expect((validateFinding({ ...base, vote: "cannot validate" }) as { verdict: string }).verdict).toBe("CANNOT_VALIDATE");
  });
  it("a value outside the enum is still rejected after normalization", () => {
    expect("error" in validateFinding({ ...base, vote: "maybe" })).toBe(true);
  });
  it("normalizeEnumValue leaves non-strings alone", () => {
    expect(normalizeEnumValue(3)).toBe(3);
  });
});

describe("#295 static schema allowlist", () => {
  const sch = (prop: Record<string, unknown>): Record<string, unknown> => ({ type: "object", properties: { x: { type: "string", ...prop } } });
  it("the shipped finding schema passes", () => {
    expect(() => assertStaticSchema(FINDING_SCHEMA)).not.toThrow();
  });
  it("a known enum in any case passes (verify.sh inline lowercase severity)", () => {
    expect(() => assertStaticSchema(sch({ enum: ["critical", "high", "medium", "low"] }))).not.toThrow();
  });
  for (const [kind, prop] of [
    ["enum", { enum: ["APPROVE", "run-4f9a-secret"] }],
    ["const", { const: "sha256:deadbeef" }],
    ["pattern", { pattern: "^acct-[0-9]{8}$" }],
  ] as [string, Record<string, unknown>][]) {
    it(`a dynamic ${kind} literal is rejected with a named error that does not echo it`, () => {
      let err: unknown;
      try { assertStaticSchema(sch(prop)); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(SchemaLiteralError);
      expect((err as Error).name).toBe("SchemaLiteralError");
      expect((err as SchemaLiteralError).kind).toBe(kind);
      expect((err as Error).message).not.toMatch(/secret|deadbeef|acct-/);
    });
  }
  it("a dynamic literal nested in items is rejected with its path", () => {
    expect(() => assertStaticSchema({ type: "array", items: { enum: ["not-static-zzz"] } })).toThrow(/\$\.items\.enum/);
  });
});

describe("schema data dir resolves from source and from the bundled dist", () => {
  const PKG = join(import.meta.dir, "..", "..");
  it("src depth and dist depth both land on loki-ts/data", () => {
    expect(resolveSchemaDataDir(join(PKG, "src", "council"))).toBe(join(PKG, "data"));
    expect(resolveSchemaDataDir(join(PKG, "dist"))).toBe(join(PKG, "data"));
  });
  it("the built bundle runs `internal sdk-judge` past schema load (no ENOENT on data/finding-schema.json)", async () => {
    const out = join(PKG, `.bundle-probe-${process.pid}`);
    mkdirSync(out, { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "loki-run.sj-"));
    try {
      const r = await Bun.build({ entrypoints: [join(PKG, "src", "cli.ts")], outdir: out, target: "bun" });
      expect(r.success).toBe(true);
      const built = join(out, "cli.js");
      expect(existsSync(built)).toBe(true);
      writeFileSync(join(dir, "p.txt"), "hi");
      writeFileSync(join(dir, "s.json"), JSON.stringify({ type: "object", properties: { verdict: { enum: ["APPROVE", "REJECT"] } } }));
      const p = Bun.spawnSync(["bun", built, "internal", "sdk-judge", "--prompt-file", join(dir, "p.txt"), "--schema-file", join(dir, "s.json"), "--model", "claude-haiku-5-5"], {
        env: { ...process.env, ANTHROPIC_API_KEY: "", LOKI_NO_BROWSER: "1" },
      });
      const stderr = p.stderr.toString();
      expect(stderr).not.toMatch(/ENOENT|finding-schema\.json/);
      expect(p.stdout.toString()).toBe("");
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
