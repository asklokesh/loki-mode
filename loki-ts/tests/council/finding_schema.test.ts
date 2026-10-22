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
import { councilAggregateVotes } from "../../src/runner/council.ts";
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
  CITATION_NOT_FOUND_TAG,
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

describe("citation existence check (positive evidence only)", () => {
  const root = mkdtempSync(join(tmpdir(), "loki-run.cite-"));
  mkdirSync(join(root, "src", "council"), { recursive: true });
  mkdirSync(join(root, "pkg", "a"), { recursive: true });
  mkdirSync(join(root, "pkg", "b"), { recursive: true });
  writeFileSync(join(root, "src", "real.ts"), "a\nb\nc\n");
  writeFileSync(join(root, "src", "council", "finding_schema.ts"), Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n") + "\n");
  writeFileSync(join(root, "pkg", "a", "dup.ts"), "1\n");
  writeFileSync(join(root, "pkg", "b", "dup.ts"), "1\n");
  const finding = (description: string, severity = "HIGH") => ({
    role: "devils_advocate",
    vote: "REJECT",
    reason: "bad",
    confidence: 0.8,
    issues: [{ severity, description }],
  });
  const issue = (d: string, ctx: { root?: string; cwd?: string; diffFiles?: string[] } = { root, diffFiles: [] }, severity = "HIGH") => {
    const r = validateFinding(finding(d, severity), ctx);
    if ("error" in r) throw new Error(r.error);
    return r.issues[0]!;
  };

  it("a unique file with the line past EOF is downgraded with a recorded note; a real line keeps HIGH", () => {
    const i = issue("bug at src/real.ts:99");
    expect(i.severity).toBe("MEDIUM");
    expect(i.description).toContain("citation not found");
    expect(i.description.startsWith(CITATION_NOT_FOUND_TAG)).toBe(true);
    expect(issue("bug at src/real.ts:3").severity).toBe("HIGH");
    expect(issue("bug at src/real.ts:99", { root, diffFiles: [] }, "CRITICAL").severity).toBe("MEDIUM");
  });

  it("a missing file downgrades only when diffFiles is supplied and lacks it", () => {
    expect(issue("bug at src/does_not_exist.ts:10", { root, diffFiles: [] }).severity).toBe("MEDIUM");
    expect(issue("bug at src/does_not_exist.ts:10", { root }).severity).toBe("HIGH"); // no diff: no evidence
    expect(issue("removed src/gone.ts:4", { root, diffFiles: ["src/gone.ts"] }).severity).toBe("HIGH"); // deleted file in the diff
  });

  it("repro: a basename citation of a real file keeps HIGH", () => {
    expect(issue("bug at finding_schema.ts:120", { root, diffFiles: [] }).severity).toBe("HIGH");
    expect(issue("bug at finding_schema.ts:5000").severity).toBe("MEDIUM"); // unique match, past EOF
  });

  it("repro: a package-relative suffix path keeps HIGH", () => {
    expect(issue("bug at council/finding_schema.ts:120", { root, diffFiles: [] }).severity).toBe("HIGH");
    expect(issue("bug at src/council/finding_schema.ts:120", { root, diffFiles: [] }).severity).toBe("HIGH");
  });

  it("repro: a backslash (Windows) path resolves like its slash form", () => {
    expect(issue("bug at src\\council\\finding_schema.ts:120", { root, diffFiles: [] }).severity).toBe("HIGH");
    expect(issue("bug at src\\real.ts:99").severity).toBe("MEDIUM");
    expect(issue("bug at pkg\\a\\dup.ts:50").severity).toBe("MEDIUM"); // the full path disambiguates dup.ts; a bare basename would not
  });

  it("repro: a deleted file named in diffFiles keeps HIGH; an ambiguous basename is never evidence", () => {
    expect(issue("gone at old/removed.ts:7", { root, diffFiles: ["old/removed.ts"] }).severity).toBe("HIGH");
    expect(issue("bug at dup.ts:50", { root, diffFiles: [] }).severity).toBe("HIGH"); // two files match
  });

  it("a base-side line past EOF of a file the diff shrank is not proof; with no diff it is skipped", () => {
    expect(issue("the deleted guard at src/real.ts:8 removes auth", { root, diffFiles: ["src/real.ts"] }).severity).toBe("HIGH");
    expect(issue("the deleted guard at real.ts:8 removes auth", { root, diffFiles: ["src\\real.ts"] }).severity).toBe("HIGH");
    expect(issue("the deleted guard at src/real.ts:8 removes auth", { root }).severity).toBe("HIGH");
    expect(issue("the deleted guard at src/real.ts:8 removes auth", { root, diffFiles: ["src/other.ts"] }).severity).toBe("MEDIUM");
  });

  it("a cwd-relative citation from a subdirectory maps to the root-relative diff path", () => {
    mkdirSync(join(root, "pkg", "a", "src"), { recursive: true });
    writeFileSync(join(root, "pkg", "a", "src", "own.ts"), "1\n2\n");
    const ctx = { root, cwd: join(root, "pkg", "a"), diffFiles: ["pkg/a/src/own.ts"] };
    expect(issue("deleted guard at src/own.ts:15 removes auth", ctx).severity).toBe("HIGH");
    expect(issue("deleted guard at src/own.ts:15 removes auth", { ...ctx, diffFiles: [] }).severity).toBe("MEDIUM");
  });

  it("a file inside a diff-listed submodule gitlink counts as touched", () => {
    mkdirSync(join(root, "pkg", "sub"), { recursive: true });
    writeFileSync(join(root, "pkg", "sub", "s.ts"), "1\n2\n");
    const ctx = { root, cwd: join(root, "pkg"), diffFiles: ["pkg/sub"] };
    expect(issue("deleted guard at sub/s.ts:15 removes auth", ctx).severity).toBe("HIGH");
    expect(issue("deleted guard at sub/s.ts:15 removes auth", { ...ctx, diffFiles: ["pkg/subx"] }).severity).toBe("MEDIUM");
  });

  describe("suffix forms of a file deleted inside a diff-listed submodule", () => {
    // No cwd: the suffix cannot be resolved against disk, so only the gitlink data can place it.
    const cite = (d: string, diffFiles: string[], gitlinks: string[] = []) =>
      issue(`deleted guard at ${d} removes auth`, { root, diffFiles, gitlinks } as never).severity;

    it("renamed gitlink: the suffix names the new path", () => {
      expect(cite("sub2/s.ts:15", ["pkg/sub2"], ["pkg/sub2"])).toBe("HIGH");
    });
    it("deleted gitlink: the directory is gone from disk", () => {
      expect(cite("gone/s.ts:15", ["pkg/gone"], ["pkg/gone"])).toBe("HIGH");
    });
    it("dotted-name deleted gitlink", () => {
      expect(cite("lib.js/s.ts:15", ["pkg/lib.js"], ["pkg/lib.js"])).toBe("HIGH");
    });
    it("nested submodule: the diff lists the outer gitlink only", () => {
      expect(cite("mid/deps/inner/n.ts:15", ["pkg/mid"], ["pkg/mid"])).toBe("HIGH");
      expect(cite("inner/n.ts:15", ["pkg/mid"], ["pkg/mid"])).toBe("MEDIUM"); // no segment names a listed gitlink: unplaceable, so refutable
    });
    it("bare basename falls under a listed gitlink, like a plain file's bare basename", () => {
      expect(cite("ghost.ts:15", ["pkg/sub2"], ["pkg/sub2"])).toBe("HIGH");
    });
    it("plain-file controls stay HIGH for the same forms (green before and after)", () => {
      expect(cite("old/removed.ts:7", ["pkg/old/removed.ts"])).toBe("HIGH");
      expect(cite("removed.ts:7", ["pkg/old/removed.ts"])).toBe("HIGH");
    });
    it("a deleted plain file is not a gitlink: an unrelated bare path still downgrades", () => {
      expect(cite("ghost.ts:15", ["pkg/old/removed.ts"])).toBe("MEDIUM");
      expect(cite("ghost.ts:15", ["pkg/dir"])).toBe("MEDIUM"); // a diff entry not reported as a gitlink is not one
    });
    it("an unplaceable path is refuted even with a gitlink bump present", () => {
      const diff = ["pkg/sub", "src/real.ts"];
      expect(cite("src/fabricated.ts:15", diff, ["pkg/sub"])).toBe("MEDIUM");
      expect(cite("totally/unrelated/ghost.ts:15", diff, ["pkg/sub"])).toBe("MEDIUM");
      expect(cite("other/s.ts:15", ["pkg/sub2"], ["pkg/sub2"])).toBe("MEDIUM");
      expect(cite("src/libfoo/x.ts:15", ["vendor/lib"], ["vendor/lib"])).toBe("MEDIUM");
      expect(cite("src/lib:15", ["vendor/lib"], ["vendor/lib"])).toBe("MEDIUM"); // the filename is not a directory component
    });
    const diff = ["pkg/sub", "pkg/real.ts"];
    it("rule (i): a bare basename stays HIGH under a listed gitlink", () => {
      expect(cite("s.ts:15", diff, ["pkg/sub"])).toBe("HIGH");
    });
    it("rule (ii): a path starting with the gitlink path plus a slash stays HIGH (it carries the final-segment component)", () => {
      expect(cite("pkg/sub/deep/x.ts:15", diff, ["pkg/sub"])).toBe("HIGH");
    });
    it("rule (ii): a component equal to the gitlink's final segment stays HIGH", () => {
      expect(cite("sub/s.ts:15", diff, ["pkg/sub"])).toBe("HIGH");
      expect(cite("a/sub/s.ts:15", diff, ["pkg/sub"])).toBe("HIGH");
    });
    it("a path sharing no component with any gitlink is refuted", () => {
      expect(cite("pkg/other/x.ts:15", diff, ["pkg/sub"])).toBe("MEDIUM");
    });
    it("a substring-only near miss is refuted, never matched as a substring", () => {
      expect(cite("src/libfoo/x.ts:15", ["vendor/lib"], ["vendor/lib"])).toBe("MEDIUM");
      expect(cite("src/sublime/x.ts:15", diff, ["pkg/sub"])).toBe("MEDIUM");
      expect(cite("pkg/subx/x.ts:15", diff, ["pkg/sub"])).toBe("MEDIUM"); // prefix without the slash boundary
    });
  });

  it("an ambiguous cwd-relative citation resolves against cwd first", () => {
    mkdirSync(join(root, "pkg", "b", "src"), { recursive: true });
    writeFileSync(join(root, "pkg", "b", "src", "own.ts"), "1\n2\n");
    const ctx = { root, cwd: join(root, "pkg", "a"), diffFiles: [] as string[] };
    expect(issue("bug at src/own.ts:15", ctx).severity).toBe("MEDIUM");
    expect(issue("bug at src/own.ts:15", { root, diffFiles: [] }).severity).toBe("HIGH");
  });

  it("council: 2 APPROVE + 1 REJECT-HIGH citing a shrunk file's base-side line stays CONTINUE", async () => {
    const mk = (role: string, vote: string, issues: unknown[] = []) => ({ role, vote, reason: "r", confidence: 0.9, issues });
    const votes = parseMultiResponse(
      JSON.stringify({ findings: [mk("a", "APPROVE"), mk("b", "APPROVE"), mk("c", "REJECT", [{ severity: "HIGH", description: "the deleted guard at finding_schema.ts:205 removes auth" }])] }),
      { root, diffFiles: ["src/council/finding_schema.ts"] },
    );
    expect((await councilAggregateVotes(votes)).decision).toBe("CONTINUE");
  });

  it("a path escaping the root is judged on the diff only", () => {
    expect(issue("bug at ../outside.ts:1", { root, diffFiles: [] }).severity).toBe("MEDIUM");
    expect(issue("bug at ../outside.ts:1", { root }).severity).toBe("HIGH");
  });

  it("no root means no check; parseMultiResponse threads the context through", () => {
    expect(issue("bug at src/real.ts:99", {}).severity).toBe("HIGH");
    const out = parseMultiResponse(JSON.stringify({ findings: [finding("bug src/real.ts:99")] }), { root, diffFiles: [] });
    expect(out[0]?.issues[0]?.severity).toBe("MEDIUM");
  });

  it("council: 2 APPROVE + 1 REJECT-HIGH on a real basename citation stays CONTINUE", async () => {
    const mk = (role: string, vote: string, issues: unknown[] = []) => ({ role, vote, reason: "r", confidence: 0.9, issues });
    const votes = parseMultiResponse(
      JSON.stringify({ findings: [mk("a", "APPROVE"), mk("b", "APPROVE"), mk("c", "REJECT", [{ severity: "HIGH", description: "race at finding_schema.ts:120" }])] }),
      { root },
    );
    const agg = await councilAggregateVotes(votes);
    expect(agg.decision).toBe("CONTINUE");
    expect(agg.blockingSeverity).toBe("HIGH");
  });

  it("cleanup", () => { rmSync(root, { recursive: true, force: true }); });
});
