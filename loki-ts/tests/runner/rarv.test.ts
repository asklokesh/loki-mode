// Tests for src/runner/rarv.ts -- tier mapping, phase names, provider tier
// param resolution, and complexity detection heuristics.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectComplexity,
  getProviderTierParam,
  getRarvPhaseName,
  getRarvTier,
} from "../../src/runner/rarv.ts";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-rarv-test-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  delete process.env["LOKI_LEGACY_TIER_SWITCHING"];
  delete process.env["LOKI_SESSION_MODEL"];
  delete process.env["LOKI_COMPLEXITY"];
  delete process.env["COMPLEXITY_TIER"];
  delete process.env["TARGET_DIR"];
  delete process.env["PROVIDER_MODEL_PLANNING"];
  delete process.env["PROVIDER_MODEL_DEVELOPMENT"];
  delete process.env["PROVIDER_MODEL_FAST"];
});

describe("rarv.getRarvTier -- iteration % 4 mapping (legacy mode)", () => {
  // iteration % 4: 0=planning, 1=development, 2=development, 3=fast.
  it.each([
    [0, "planning"],
    [1, "development"],
    [4, "planning"],
    [5, "development"],
    [100, "planning"],
    [101, "development"],
    [102, "development"],
    [103, "fast"],
  ] as const)("iteration %d -> %s in legacy mode", (iter, expected) => {
    expect(getRarvTier(iter, { legacy: true })).toBe(expected);
  });

  it("respects LOKI_LEGACY_TIER_SWITCHING=true env var", () => {
    process.env["LOKI_LEGACY_TIER_SWITCHING"] = "true";
    expect(getRarvTier(0)).toBe("planning");
    expect(getRarvTier(3)).toBe("fast");
  });
});

describe("rarv.getRarvTier -- session-pinned mode (default)", () => {
  it("pins to development for sonnet (default)", () => {
    expect(getRarvTier(0, { sessionModel: "sonnet" })).toBe("development");
    expect(getRarvTier(99, { sessionModel: "sonnet" })).toBe("development");
  });

  it("pins to planning for opus", () => {
    expect(getRarvTier(3, { sessionModel: "opus" })).toBe("planning");
  });

  it("pins to fast for haiku", () => {
    expect(getRarvTier(0, { sessionModel: "haiku" })).toBe("fast");
  });

  it("passes through tier names directly", () => {
    expect(getRarvTier(0, { sessionModel: "fast" })).toBe("fast");
    expect(getRarvTier(0, { sessionModel: "planning" })).toBe("planning");
  });

  it("default sessionModel is sonnet -> development", () => {
    expect(getRarvTier(0)).toBe("development");
  });
});

describe("rarv.getRarvPhaseName", () => {
  it.each([
    [0, "REASON"],
    [1, "ACT"],
    [2, "REFLECT"],
    [3, "VERIFY"],
    [4, "REASON"],
    [101, "ACT"],
  ] as const)("iteration %d -> %s", (iter, expected) => {
    expect(getRarvPhaseName(iter)).toBe(expected);
  });
});

describe("rarv.getProviderTierParam -- legacy fallback table", () => {
  it("claude tier mapping", () => {
    // v7.104.0: Sonnet 5 is the default execution model (planning + development
    // default to sonnet, was opus). fast stays sonnet.
    expect(getProviderTierParam("planning", "claude")).toBe("sonnet");
    expect(getProviderTierParam("development", "claude")).toBe("sonnet");
    expect(getProviderTierParam("fast", "claude")).toBe("sonnet");
  });

  it("codex tier mapping", () => {
    expect(getProviderTierParam("planning", "codex")).toBe("xhigh");
    expect(getProviderTierParam("development", "codex")).toBe("high");
    expect(getProviderTierParam("fast", "codex")).toBe("low");
  });

  it("cline default", () => {
    expect(getProviderTierParam("planning", "cline")).toBe("default");
  });

  it("aider default", () => {
    expect(getProviderTierParam("planning", "aider")).toBe("claude-opus-4-7");
  });

  it("respects PROVIDER_MODEL_PLANNING env override", () => {
    process.env["PROVIDER_MODEL_PLANNING"] = "claude-opus-5";
    expect(getProviderTierParam("planning", "claude")).toBe("claude-opus-5");
  });

  it("unknown provider returns generic 'development'", () => {
    expect(getProviderTierParam("planning", "unknown")).toBe("development");
  });
});

describe("rarv.detectComplexity -- override paths", () => {
  it("returns override when explicitly provided", () => {
    const r = detectComplexity({ override: "complex" });
    expect(r.complexity).toBe("complex");
  });

  it("respects LOKI_COMPLEXITY env var", () => {
    process.env["LOKI_COMPLEXITY"] = "complex";
    const r = detectComplexity({ filesGlob: scratch });
    expect(r.complexity).toBe("complex");
  });

  it("respects COMPLEXITY_TIER env var (bash idiom)", () => {
    process.env["COMPLEXITY_TIER"] = "simple";
    const r = detectComplexity({ filesGlob: scratch });
    expect(r.complexity).toBe("simple");
  });

  it("ignores 'auto' override and falls through to detection", () => {
    process.env["COMPLEXITY_TIER"] = "auto";
    const r = detectComplexity({ filesGlob: scratch });
    // empty dir, no PRD -> standard.
    expect(r.complexity).toBe("standard");
  });

  it("ignores invalid override values", () => {
    const r = detectComplexity({ override: "bogus", filesGlob: scratch });
    expect(r.complexity).toBe("standard");
  });
});

describe("rarv.detectComplexity -- file-count branches", () => {
  function writeSourceFiles(count: number, ext = ".ts") {
    for (let i = 0; i < count; i++) {
      writeFileSync(join(scratch, `src${i}${ext}`), `// stub ${i}`);
    }
  }

  it("simple: <=5 source files + simple PRD + no integrations", () => {
    writeSourceFiles(3);
    const prd = join(scratch, "prd.md");
    writeFileSync(prd, "# Tiny PRD\nA small thing.");
    const r = detectComplexity({ filesGlob: scratch, prdPath: prd });
    expect(r.fileCount).toBe(3);
    expect(r.prdComplexity).toBe("simple");
    expect(r.complexity).toBe("simple");
  });

  it("complex: >50 source files", () => {
    writeSourceFiles(51);
    const r = detectComplexity({ filesGlob: scratch });
    expect(r.fileCount).toBe(51);
    expect(r.complexity).toBe("complex");
  });

  it("complex: docker-compose.yml triggers microservices", () => {
    writeSourceFiles(3);
    writeFileSync(join(scratch, "docker-compose.yml"), "services: {}");
    const r = detectComplexity({ filesGlob: scratch });
    expect(r.hasMicroservices).toBe(true);
    expect(r.complexity).toBe("complex");
  });

  it("complex: k8s/ directory triggers microservices", () => {
    writeSourceFiles(3);
    mkdirSync(join(scratch, "k8s"));
    const r = detectComplexity({ filesGlob: scratch });
    expect(r.hasMicroservices).toBe(true);
    expect(r.complexity).toBe("complex");
  });

  it("complex: external integrations match (oauth)", () => {
    writeFileSync(join(scratch, "auth.ts"), "// uses oauth and SAML for SSO");
    const r = detectComplexity({ filesGlob: scratch });
    expect(r.hasExternal).toBe(true);
    expect(r.complexity).toBe("complex");
  });

  it("complex: stripe in package.json", () => {
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ deps: { stripe: "^1.0" } }));
    const r = detectComplexity({ filesGlob: scratch });
    expect(r.hasExternal).toBe(true);
    expect(r.complexity).toBe("complex");
  });

  it("standard: 6-50 files, no PRD, no integrations", () => {
    for (let i = 0; i < 10; i++) writeFileSync(join(scratch, `src${i}.ts`), "// stub");
    const r = detectComplexity({ filesGlob: scratch });
    expect(r.complexity).toBe("standard");
  });

  it("excludes node_modules and dist from file count", () => {
    mkdirSync(join(scratch, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(scratch, "node_modules", "pkg", "index.js"), "// dep");
    mkdirSync(join(scratch, "dist"));
    writeFileSync(join(scratch, "dist", "bundle.js"), "// build");
    writeFileSync(join(scratch, "src.ts"), "// real");
    const r = detectComplexity({ filesGlob: scratch });
    expect(r.fileCount).toBe(1);
  });
});

describe("rarv.detectComplexity -- PRD heuristics", () => {
  it("simple PRD: <200 words, <5 features, <3 sections", () => {
    const prd = join(scratch, "prd.md");
    writeFileSync(prd, "# title\n\nshort thing\n\n## one\n\n- [ ] a single task\n");
    const r = detectComplexity({ filesGlob: scratch, prdPath: prd });
    expect(r.prdComplexity).toBe("simple");
  });

  it("complex PRD: many words", () => {
    const prd = join(scratch, "prd.md");
    const body = "word ".repeat(1500);
    writeFileSync(prd, `# title\n\n${body}`);
    const r = detectComplexity({ filesGlob: scratch, prdPath: prd });
    expect(r.prdComplexity).toBe("complex");
  });

  it("complex PRD: >15 features (h2 + checkbox count)", () => {
    const prd = join(scratch, "prd.md");
    const features = Array.from({ length: 20 }, (_, i) => `## Feature ${i}`).join("\n");
    writeFileSync(prd, `# title\n${features}\n`);
    const r = detectComplexity({ filesGlob: scratch, prdPath: prd });
    expect(r.prdComplexity).toBe("complex");
  });

  it("complex PRD: >10 sections (h2 + h3)", () => {
    const prd = join(scratch, "prd.md");
    const sections = Array.from({ length: 12 }, (_, i) => `### Section ${i}`).join("\n");
    writeFileSync(prd, `# title\n${sections}\n`);
    const r = detectComplexity({ filesGlob: scratch, prdPath: prd });
    expect(r.prdComplexity).toBe("complex");
  });

  it("JSON PRD: counts features/requirements/tasks arrays", () => {
    const prd = join(scratch, "prd.json");
    writeFileSync(
      prd,
      JSON.stringify({
        features: Array(10).fill({ name: "x" }),
        requirements: Array(8).fill({ name: "y" }),
      }),
    );
    const r = detectComplexity({ filesGlob: scratch, prdPath: prd });
    // 10 + 8 = 18 features -> complex by featureCount > 15
    expect(r.prdComplexity).toBe("complex");
  });

  it("complex PRD elevates non-simple even when files <= 5", () => {
    const prd = join(scratch, "prd.md");
    writeFileSync(prd, "# title\n" + "## h\n".repeat(20));
    writeFileSync(join(scratch, "main.ts"), "// stub");
    const r = detectComplexity({ filesGlob: scratch, prdPath: prd });
    expect(r.prdComplexity).toBe("complex");
    expect(r.complexity).toBe("complex");
  });
});
