import { describe, expect, it } from "bun:test";
import {
  HIGH_TIER_REVIEWERS,
  leanReviewerFlags,
  reviewerModelForTier,
  routeReviewer,
} from "../../src/util/reviewer_routing.ts";

describe("reviewerModelForTier", () => {
  it("routes specialists to haiku on simple and standard tiers", () => {
    for (const tier of ["simple", "standard", "SIMPLE", " Standard "]) {
      expect(reviewerModelForTier({ tier, reviewer: "test-coverage-auditor", env: {} })).toBe("haiku");
      expect(reviewerModelForTier({ tier, reviewer: "architecture-strategist", env: {} })).toBe("haiku");
    }
  });

  it("leaves complex tier unpinned (account default)", () => {
    expect(reviewerModelForTier({ tier: "complex", reviewer: "test-coverage-auditor", env: {} })).toBeNull();
  });

  it("leaves unknown or absent tier unpinned (fail toward today's behavior)", () => {
    expect(reviewerModelForTier({ tier: undefined, reviewer: "x", env: {} })).toBeNull();
    expect(reviewerModelForTier({ tier: "bogus", reviewer: "x", env: {} })).toBeNull();
  });

  it("never downgrades HIGH-tier moat reviewers", () => {
    for (const r of HIGH_TIER_REVIEWERS) {
      expect(reviewerModelForTier({ tier: "simple", reviewer: r, env: {} })).toBeNull();
    }
    expect(reviewerModelForTier({ tier: "simple", reviewer: "security-sentinel", env: {} })).toBeNull();
    expect(reviewerModelForTier({ tier: "simple", reviewer: "devils-advocate", env: {} })).toBeNull();
  });

  it("never downgrades when the change itself is HIGH tier", () => {
    expect(reviewerModelForTier({ tier: "simple", reviewer: "test-coverage-auditor", highTier: true, env: {} })).toBeNull();
  });

  it("explicit LOKI_ADVISOR_MODEL wins over tier routing; fable is refused", () => {
    expect(reviewerModelForTier({ tier: "simple", reviewer: "a", env: { LOKI_ADVISOR_MODEL: "opus" } })).toBe("opus");
    expect(reviewerModelForTier({ tier: "complex", reviewer: "a", env: { LOKI_ADVISOR_MODEL: "sonnet" } })).toBe("sonnet");
    expect(reviewerModelForTier({ tier: "simple", reviewer: "a", env: { LOKI_ADVISOR_MODEL: "fable" } })).toBe("haiku");
    expect(reviewerModelForTier({ tier: "complex", reviewer: "a", env: { LOKI_ADVISOR_MODEL: "fable" } })).toBeNull();
  });

  it("LOKI_REVIEWER_TIER_ROUTING=0 disables routing", () => {
    expect(reviewerModelForTier({ tier: "simple", reviewer: "a", env: { LOKI_REVIEWER_TIER_ROUTING: "0" } })).toBeNull();
  });
});

describe("leanReviewerFlags", () => {
  const supported = () => true;
  it("uses --bare only when an API key exists", () => {
    expect(leanReviewerFlags({ env: { ANTHROPIC_API_KEY: "sk-x" }, flagSupported: supported })).toEqual(["--bare", "--tools", ""]);
  });

  it("OAuth-only host never gets --bare", () => {
    const f = leanReviewerFlags({ env: {}, flagSupported: supported });
    expect(f).not.toContain("--bare");
    expect(f).toContain("--setting-sources");
    expect(f[f.indexOf("--setting-sources") + 1]).toBe("project");
    expect(f).toContain("--strict-mcp-config");
    expect(f).toContain("--disable-slash-commands");
  });

  it("whitespace-only key does not count", () => {
    expect(leanReviewerFlags({ env: { ANTHROPIC_API_KEY: "  " }, flagSupported: supported })).not.toContain("--bare");
  });

  it("LOKI_BARE_SUBCALLS=0 disables --bare", () => {
    expect(leanReviewerFlags({ env: { ANTHROPIC_API_KEY: "k", LOKI_BARE_SUBCALLS: "0" }, flagSupported: supported })).not.toContain("--bare");
  });

  it("drops unsupported flags, never passes them", () => {
    const f = leanReviewerFlags({ env: {}, flagSupported: (x) => x !== "--disable-slash-commands" && x !== "--tools" });
    expect(f).not.toContain("--disable-slash-commands");
    expect(f).not.toContain("--tools");
    expect(f).toContain("--strict-mcp-config");
    expect(leanReviewerFlags({ env: { ANTHROPIC_API_KEY: "k" }, flagSupported: (x) => x !== "--bare" })).not.toContain("--bare");
  });

  it("LOKI_LEAN_CHILDREN=0 disables lean flags entirely", () => {
    expect(leanReviewerFlags({ env: { LOKI_LEAN_CHILDREN: "0", ANTHROPIC_API_KEY: "k" }, flagSupported: supported })).toEqual([]);
  });
});

describe("routeReviewer", () => {
  it("small tier gets haiku plus lean flags", () => {
    const r = routeReviewer({ tier: "simple", reviewer: "t", env: {}, flagSupported: () => true });
    expect(r.model).toBe("haiku");
    expect(r.flags.length).toBeGreaterThan(0);
  });
  it("complex tier and moat reviewers get no model and no lean flags", () => {
    expect(routeReviewer({ tier: "complex", reviewer: "t", env: {}, flagSupported: () => true })).toEqual({ model: null, flags: [] });
    expect(routeReviewer({ tier: "simple", reviewer: "security-sentinel", env: {}, flagSupported: () => true })).toEqual({ model: null, flags: [] });
  });
});
