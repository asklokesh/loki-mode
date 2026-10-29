// loki-ts/tests/providers/claude_flags.test.ts -- Phase B (v7.5.19) regression tests.
//
// Bun-route mirror of tests/test-claude-flags.sh. Covers:
// - effortForTier maps RARV tier -> effort level
// - effortForTier shifts up one notch on complexity=complex
// - remainingBudget reads .loki/metrics/budget.json subtracts spend
// - remainingBudget returns null when limit unset, 0, or remaining <= 0
// - fallbackForPrimary opus->sonnet always; sonnet->haiku gated on LOKI_ALLOW_HAIKU
// - claudeFlagSupported respects the cache; ensureClaudeHelpCache idempotent
// - buildAutoFlags composes only supported + non-null flags
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effortForTier,
  remainingBudget,
  fallbackForPrimary,
  claudeFlagSupported,
  buildAutoFlags,
  permissionArgv,
  permissionPolicyMode,
  permissionPolicyBanner,
  resetPermissionPolicyWarning,
  sdkPermissionOptions,
  claudeSessionUuid,
  claudeIterationSessionUuid,
  sessionStampArgv,
  reviewAllowlistEnabled,
  reviewAllowlistArgv,
  REVIEW_ALLOWLIST_TOKEN,
  resumeSessionEnabled,
  sessionForkEnabled,
  resumeTargetUuid,
  sessionResumeArgv,
  _resetClaudeHelpCacheForTest,
  AUTONOMY_OVERRIDE_TEXT,
  FIRST_PASS_EXCELLENCE_TEXT,
  reviewerModelForTier,
  leanReviewerFlags,
  clampThinkingForEffort,
  thinkingConflictsEffort,
  thinkingUsageError,
} from "../../src/providers/claude_flags.ts";

describe("effortForTier model clamp", () => {
  const cat = join(mkdtempSync(join(tmpdir(), "clampcat-")), "cat.json");
  writeFileSync(cat, JSON.stringify({ providers: { claude: { cli_aliases: { mini: "m-low" }, models: [
    { id: "m-low", alias: "mini", effort: { levels: ["low", "medium", "high"] } },
    { id: "m-all", effort: { levels: ["low", "medium", "high", "xhigh", "max"] } },
    { id: "m-none", effort: { levels: [] } },
  ] } } }));
  const prev = process.env["LOKI_MODEL_CATALOG"];
  beforeEach(() => { process.env["LOKI_MODEL_CATALOG"] = cat; });
  afterEach(() => { if (prev === undefined) delete process.env["LOKI_MODEL_CATALOG"]; else process.env["LOKI_MODEL_CATALOG"] = prev; });
  it("clamps xhigh to the highest allowed level", () => { expect(effortForTier("planning", "standard", "m-low")).toBe("high"); });
  it("resolves a cli alias", () => { expect(effortForTier("planning", "standard", "mini")).toBe("high"); });
  it("leaves a supported level alone", () => { expect(effortForTier("planning", "standard", "m-all")).toBe("xhigh"); });
  it("leaves unknown models alone", () => {
    expect(effortForTier("planning", "standard", "unknown-model")).toBe("xhigh");
  });
  it("returns null for a no-effort model so the caller omits --effort", () => {
    expect(effortForTier("planning", "standard", "m-none")).toBeNull();
    expect(effortForTier("fast", "standard", "m-none")).toBeNull();
  });
  it("catalog haiku-4-5 has no effort parameter", () => {
    delete process.env["LOKI_MODEL_CATALOG"];
    expect(effortForTier("planning", "standard", "claude-haiku-4-5")).toBeNull();
    expect(effortForTier("fast", "standard", "claude-haiku-4-5")).toBeNull();
  });
  it("catalog haiku-5-5 supports the planning effort", () => {
    delete process.env["LOKI_MODEL_CATALOG"];
    expect(effortForTier("planning", "standard", "claude-haiku-5-5")).toBe("xhigh");
  });
});

describe("claude_flags.effortForTier", () => {
  it("maps planning -> xhigh", () => {
    expect(effortForTier("planning")).toBe("xhigh");
  });
  it("maps development -> high", () => {
    expect(effortForTier("development")).toBe("high");
  });
  it("maps fast -> medium", () => {
    expect(effortForTier("fast")).toBe("medium");
  });
  it("maps capability aliases best/balanced/cheap", () => {
    expect(effortForTier("best")).toBe("xhigh");
    expect(effortForTier("balanced")).toBe("high");
    expect(effortForTier("cheap")).toBe("low");
  });
  it("unknown tier defaults to high", () => {
    expect(effortForTier("mystery")).toBe("high");
    expect(effortForTier(undefined)).toBe("high");
  });
  it("complexity=complex shifts one notch up; xhigh stays xhigh", () => {
    expect(effortForTier("cheap", "complex")).toBe("medium");
    expect(effortForTier("fast", "complex")).toBe("high");
    expect(effortForTier("development", "complex")).toBe("xhigh");
    expect(effortForTier("planning", "complex")).toBe("xhigh"); // no auto-max
  });
});

describe("claude_flags.remainingBudget", () => {
  let td: string;
  let savedLimit: string | undefined;
  let savedTargetDir: string | undefined;

  beforeEach(() => {
    td = mkdtempSync(join(tmpdir(), "loki-cf-rb-"));
    mkdirSync(join(td, ".loki", "metrics"), { recursive: true });
    savedLimit = process.env["LOKI_BUDGET_LIMIT"];
    savedTargetDir = process.env["TARGET_DIR"];
  });

  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
    if (savedLimit === undefined) delete process.env["LOKI_BUDGET_LIMIT"];
    else process.env["LOKI_BUDGET_LIMIT"] = savedLimit;
    if (savedTargetDir === undefined) delete process.env["TARGET_DIR"];
    else process.env["TARGET_DIR"] = savedTargetDir;
  });

  it("returns null when LOKI_BUDGET_LIMIT unset", () => {
    delete process.env["LOKI_BUDGET_LIMIT"];
    expect(remainingBudget(td)).toBeNull();
  });
  it("returns null when LOKI_BUDGET_LIMIT=0", () => {
    process.env["LOKI_BUDGET_LIMIT"] = "0";
    expect(remainingBudget(td)).toBeNull();
  });
  it("returns full limit (2dp) when no budget.json present", () => {
    process.env["LOKI_BUDGET_LIMIT"] = "50";
    expect(remainingBudget(td)).toBe("50.00");
  });
  it("computes 50 - 12.34 = 37.66", () => {
    process.env["LOKI_BUDGET_LIMIT"] = "50";
    writeFileSync(join(td, ".loki", "metrics", "budget.json"), JSON.stringify({ limit: 50, budget_limit: 50, budget_used: 12.34, exceeded: false }));
    expect(remainingBudget(td)).toBe("37.66");
  });
  it("returns null when overspent (never emits 0 or negative)", () => {
    process.env["LOKI_BUDGET_LIMIT"] = "50";
    writeFileSync(join(td, ".loki", "metrics", "budget.json"), JSON.stringify({ limit: 50, budget_limit: 50, budget_used: 60.0, exceeded: true }));
    expect(remainingBudget(td)).toBeNull();
  });
  it("returns null on malformed budget.json (no throw)", () => {
    process.env["LOKI_BUDGET_LIMIT"] = "50";
    writeFileSync(join(td, ".loki", "metrics", "budget.json"), "not json");
    // Malformed file -> spend treated as 0 -> emits full limit
    expect(remainingBudget(td)).toBe("50.00");
  });
});

describe("claude_flags.fallbackForPrimary", () => {
  it("opus -> sonnet always", () => {
    expect(fallbackForPrimary("opus", false)).toBe("sonnet");
    expect(fallbackForPrimary("opus", true)).toBe("sonnet");
  });
  it("sonnet -> haiku only when allowHaiku=true", () => {
    expect(fallbackForPrimary("sonnet", false)).toBeNull();
    expect(fallbackForPrimary("sonnet", true)).toBe("haiku");
  });
  it("haiku -> null (no further fallback)", () => {
    expect(fallbackForPrimary("haiku", true)).toBeNull();
  });
  it("dated id -> null (no auto-fallback we can reason about)", () => {
    expect(fallbackForPrimary("claude-opus-4-7", true)).toBeNull();
  });
  it("empty/undefined -> null", () => {
    expect(fallbackForPrimary(undefined)).toBeNull();
    expect(fallbackForPrimary("")).toBeNull();
  });
});

describe("claude_flags.claudeFlagSupported + cache", () => {
  beforeEach(() => {
    _resetClaudeHelpCacheForTest(null);
  });
  it("returns false with empty cache (conservative)", () => {
    expect(claudeFlagSupported("--effort")).toBe(false);
  });
  it("returns true when text contains the flag", () => {
    _resetClaudeHelpCacheForTest("  --effort <level>  Effort level\n  --max-budget-usd <amount>  Max budget");
    expect(claudeFlagSupported("--effort")).toBe(true);
    expect(claudeFlagSupported("--max-budget-usd")).toBe(true);
  });
  it("returns false for unknown flag even with cache", () => {
    _resetClaudeHelpCacheForTest("  --effort <level>  Effort level");
    expect(claudeFlagSupported("--not-a-real-flag-zzz")).toBe(false);
  });
});

describe("claude_flags.buildAutoFlags composition", () => {
  let td: string;
  let savedLimit: string | undefined;
  let savedHaiku: string | undefined;

  beforeEach(() => {
    td = mkdtempSync(join(tmpdir(), "loki-cf-baf-"));
    savedLimit = process.env["LOKI_BUDGET_LIMIT"];
    savedHaiku = process.env["LOKI_ALLOW_HAIKU"];
    _resetClaudeHelpCacheForTest(null);
  });
  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
    if (savedLimit === undefined) delete process.env["LOKI_BUDGET_LIMIT"];
    else process.env["LOKI_BUDGET_LIMIT"] = savedLimit;
    if (savedHaiku === undefined) delete process.env["LOKI_ALLOW_HAIKU"];
    else process.env["LOKI_ALLOW_HAIKU"] = savedHaiku;
  });

  it("emits no flags when help cache empty (conservative)", () => {
    process.env["LOKI_BUDGET_LIMIT"] = "100";
    const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
    expect(out).toEqual([]);
  });

  it("emits --effort only when help mentions it and no budget set", () => {
    _resetClaudeHelpCacheForTest("  --effort <level>  Effort level");
    delete process.env["LOKI_BUDGET_LIMIT"];
    const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
    expect(out).toEqual(["--effort", "high"]);
  });

  it("emits --effort + --max-budget-usd when both supported and budget present", () => {
    _resetClaudeHelpCacheForTest("  --effort <level>\n  --max-budget-usd <amount>");
    process.env["LOKI_BUDGET_LIMIT"] = "50";
    const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
    expect(out).toEqual(["--effort", "high", "--max-budget-usd", "50.00"]);
  });

  it("emits --fallback-model when supported + primary=opus", () => {
    _resetClaudeHelpCacheForTest("  --fallback-model <model>");
    delete process.env["LOKI_BUDGET_LIMIT"];
    const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
    expect(out).toEqual(["--fallback-model", "sonnet"]);
  });

  it("composes all three flags when fully supported + everything set", () => {
    _resetClaudeHelpCacheForTest("  --effort\n  --max-budget-usd\n  --fallback-model");
    process.env["LOKI_BUDGET_LIMIT"] = "100";
    process.env["LOKI_ALLOW_HAIKU"] = "true";
    const out = buildAutoFlags({ tier: "fast", primary: "sonnet", complexity: "complex", targetDir: td });
    // fast + complex -> high effort, primary sonnet + allow-haiku -> fallback haiku
    expect(out).toEqual(["--effort", "high", "--max-budget-usd", "100.00", "--fallback-model", "haiku"]);
  });

  it("skips overspent budget cleanly (no --max-budget-usd 0)", () => {
    _resetClaudeHelpCacheForTest("  --effort\n  --max-budget-usd");
    process.env["LOKI_BUDGET_LIMIT"] = "10";
    mkdirSync(join(td, ".loki", "metrics"), { recursive: true });
    writeFileSync(join(td, ".loki", "metrics", "budget.json"), JSON.stringify({ limit: 10, budget_limit: 10, budget_used: 100, exceeded: true }));
    const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
    expect(out).toEqual(["--effort", "high"]);
    // Crucially: no "--max-budget-usd" in the output
    expect(out.includes("--max-budget-usd")).toBe(false);
  });

  // Phase E (v7.5.20) regression tests.
  it("emits --exclude-dynamic-system-prompt-sections when supported (default on)", () => {
    _resetClaudeHelpCacheForTest("  --exclude-dynamic-system-prompt-sections  Move per-machine sections");
    delete process.env["LOKI_DYNAMIC_PROMPT_SECTIONS"];
    const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
    expect(out.includes("--exclude-dynamic-system-prompt-sections")).toBe(true);
  });

  it("suppresses --exclude-dynamic-system-prompt-sections when LOKI_DYNAMIC_PROMPT_SECTIONS=keep", () => {
    _resetClaudeHelpCacheForTest("  --exclude-dynamic-system-prompt-sections");
    process.env["LOKI_DYNAMIC_PROMPT_SECTIONS"] = "keep";
    const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
    expect(out.includes("--exclude-dynamic-system-prompt-sections")).toBe(false);
    delete process.env["LOKI_DYNAMIC_PROMPT_SECTIONS"];
  });

  it("omits --exclude-dynamic-system-prompt-sections when CLI lacks support", () => {
    _resetClaudeHelpCacheForTest("  --effort");
    delete process.env["LOKI_DYNAMIC_PROMPT_SECTIONS"];
    const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
    expect(out.includes("--exclude-dynamic-system-prompt-sections")).toBe(false);
  });

  // v8 first-pass-excellence append: iteration-1-only + LOKI_FIRST_PASS_EXCELLENCE
  // gate. The appended system prompt text must mirror providers/claude.sh.
  describe("first-pass-excellence append", () => {
    let savedIter: string | undefined;
    let savedFP: string | undefined;
    let savedOverride: string | undefined;
    beforeEach(() => {
      savedIter = process.env["ITERATION_COUNT"];
      savedFP = process.env["LOKI_FIRST_PASS_EXCELLENCE"];
      savedOverride = process.env["LOKI_AUTONOMY_OVERRIDE"];
      _resetClaudeHelpCacheForTest("  --append-system-prompt <text>");
    });
    afterEach(() => {
      for (const [k, v] of [
        ["ITERATION_COUNT", savedIter],
        ["LOKI_FIRST_PASS_EXCELLENCE", savedFP],
        ["LOKI_AUTONOMY_OVERRIDE", savedOverride],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const appendText = (out: string[]): string => {
      const i = out.indexOf("--append-system-prompt");
      expect(i).toBeGreaterThanOrEqual(0);
      return out[i + 1]!;
    };

    it("appends the first-pass block on iteration 1 (default gate on)", () => {
      process.env["ITERATION_COUNT"] = "1";
      delete process.env["LOKI_FIRST_PASS_EXCELLENCE"];
      const out = buildAutoFlags({ tier: "fast", primary: "sonnet", targetDir: td });
      expect(appendText(out)).toBe(AUTONOMY_OVERRIDE_TEXT + FIRST_PASS_EXCELLENCE_TEXT);
    });

    it("does NOT append the first-pass block on iteration 2 (base only)", () => {
      process.env["ITERATION_COUNT"] = "2";
      const out = buildAutoFlags({ tier: "fast", primary: "sonnet", targetDir: td });
      expect(appendText(out)).toBe(AUTONOMY_OVERRIDE_TEXT);
    });

    it("suppresses the first-pass block when LOKI_FIRST_PASS_EXCELLENCE=0", () => {
      process.env["ITERATION_COUNT"] = "1";
      process.env["LOKI_FIRST_PASS_EXCELLENCE"] = "0";
      const out = buildAutoFlags({ tier: "fast", primary: "sonnet", targetDir: td });
      expect(appendText(out)).toBe(AUTONOMY_OVERRIDE_TEXT);
    });

    it("first-pass text names the key anti-slop tells and the wire-the-backend rule", () => {
      // Guards against the directive silently losing its research-grounded content.
      expect(FIRST_PASS_EXCELLENCE_TEXT).toContain("FIRST-PASS EXCELLENCE");
      expect(FIRST_PASS_EXCELLENCE_TEXT).toContain("WIRE IT");
      expect(FIRST_PASS_EXCELLENCE_TEXT).toContain("indigo/blue-to-purple gradient");
      expect(FIRST_PASS_EXCELLENCE_TEXT).toContain("observed behavior");
    });
  });

  // Phase D (v7.5.22) regression tests for --mcp-config + --include-hook-events.
  it("adds --mcp-config <path> when CLI advertises it", () => {
    _resetClaudeHelpCacheForTest("  --mcp-config <configs...>  Load MCP servers from JSON files");
    const savedHookEnv = process.env["LOKI_HOOK_EVENTS"];
    process.env["LOKI_HOOK_EVENTS"] = "off"; // Isolate to mcp-config emission.
    try {
      const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
      const idx = out.indexOf("--mcp-config");
      expect(idx).toBeGreaterThanOrEqual(0);
      // Next element must be the Loki bundle path under targetDir.
      expect(out[idx + 1]).toBe(join(td, ".loki", "mcp-config.json"));
    } finally {
      if (savedHookEnv === undefined) delete process.env["LOKI_HOOK_EVENTS"];
      else process.env["LOKI_HOOK_EVENTS"] = savedHookEnv;
    }
  });

  it("does NOT add --mcp-config when CLI does not advertise it (conservative)", () => {
    _resetClaudeHelpCacheForTest("  --effort"); // No --mcp-config in help.
    const savedHookEnv = process.env["LOKI_HOOK_EVENTS"];
    process.env["LOKI_HOOK_EVENTS"] = "off";
    try {
      const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
      expect(out.includes("--mcp-config")).toBe(false);
    } finally {
      if (savedHookEnv === undefined) delete process.env["LOKI_HOOK_EVENTS"];
      else process.env["LOKI_HOOK_EVENTS"] = savedHookEnv;
    }
  });

  // EMBED 1 (v7.33.0): --strict-mcp-config -- only alongside --mcp-config.
  it("adds --strict-mcp-config when --mcp-config is emitted and CLI supports it (default on)", () => {
    _resetClaudeHelpCacheForTest(
      "  --mcp-config <configs...>  Load MCP servers\n  --strict-mcp-config  Only use MCP servers from --mcp-config",
    );
    const savedHookEnv = process.env["LOKI_HOOK_EVENTS"];
    const savedStrict = process.env["LOKI_STRICT_MCP"];
    process.env["LOKI_HOOK_EVENTS"] = "off";
    delete process.env["LOKI_STRICT_MCP"];
    try {
      const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
      expect(out.includes("--mcp-config")).toBe(true);
      expect(out.includes("--strict-mcp-config")).toBe(true);
      // strict must come AFTER the mcp-config path (never bare / standalone).
      expect(out.indexOf("--strict-mcp-config")).toBeGreaterThan(out.indexOf("--mcp-config"));
    } finally {
      if (savedHookEnv === undefined) delete process.env["LOKI_HOOK_EVENTS"];
      else process.env["LOKI_HOOK_EVENTS"] = savedHookEnv;
      if (savedStrict === undefined) delete process.env["LOKI_STRICT_MCP"];
      else process.env["LOKI_STRICT_MCP"] = savedStrict;
    }
  });

  it("omits --strict-mcp-config when the CLI lacks it (mcp-config supported, graceful degrade)", () => {
    // Help advertises --mcp-config but NOT --strict-mcp-config. Note the help
    // text deliberately avoids the literal substring "--strict-mcp-config".
    _resetClaudeHelpCacheForTest("  --mcp-config <configs...>  Load MCP servers from JSON files");
    const savedHookEnv = process.env["LOKI_HOOK_EVENTS"];
    const savedStrict = process.env["LOKI_STRICT_MCP"];
    process.env["LOKI_HOOK_EVENTS"] = "off";
    delete process.env["LOKI_STRICT_MCP"];
    try {
      const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
      // mcp-config IS emitted (advertised), strict is NOT (not advertised).
      expect(out.includes("--mcp-config")).toBe(true);
      expect(out.includes("--strict-mcp-config")).toBe(false);
    } finally {
      if (savedHookEnv === undefined) delete process.env["LOKI_HOOK_EVENTS"];
      else process.env["LOKI_HOOK_EVENTS"] = savedHookEnv;
      if (savedStrict === undefined) delete process.env["LOKI_STRICT_MCP"];
      else process.env["LOKI_STRICT_MCP"] = savedStrict;
    }
  });

  it("suppresses --strict-mcp-config when LOKI_STRICT_MCP=0 (opt-out), mcp-config still emitted", () => {
    _resetClaudeHelpCacheForTest(
      "  --mcp-config <configs...>  Load MCP servers\n  --strict-mcp-config  Only use MCP servers from --mcp-config",
    );
    const savedHookEnv = process.env["LOKI_HOOK_EVENTS"];
    const savedStrict = process.env["LOKI_STRICT_MCP"];
    process.env["LOKI_HOOK_EVENTS"] = "off";
    process.env["LOKI_STRICT_MCP"] = "0";
    try {
      const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
      expect(out.includes("--mcp-config")).toBe(true);
      expect(out.includes("--strict-mcp-config")).toBe(false);
    } finally {
      if (savedHookEnv === undefined) delete process.env["LOKI_HOOK_EVENTS"];
      else process.env["LOKI_HOOK_EVENTS"] = savedHookEnv;
      if (savedStrict === undefined) delete process.env["LOKI_STRICT_MCP"];
      else process.env["LOKI_STRICT_MCP"] = savedStrict;
    }
  });

  it("skips --include-hook-events when LOKI_HOOK_EVENTS=off (even if supported)", () => {
    _resetClaudeHelpCacheForTest("  --include-hook-events  Include all hook lifecycle events");
    const savedHookEnv = process.env["LOKI_HOOK_EVENTS"];
    process.env["LOKI_HOOK_EVENTS"] = "off";
    try {
      const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
      expect(out.includes("--include-hook-events")).toBe(false);
    } finally {
      if (savedHookEnv === undefined) delete process.env["LOKI_HOOK_EVENTS"];
      else process.env["LOKI_HOOK_EVENTS"] = savedHookEnv;
    }
  });

  it("emits --include-hook-events when supported and LOKI_HOOK_EVENTS unset (default on)", () => {
    _resetClaudeHelpCacheForTest("  --include-hook-events  Include all hook lifecycle events");
    const savedHookEnv = process.env["LOKI_HOOK_EVENTS"];
    delete process.env["LOKI_HOOK_EVENTS"];
    try {
      const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
      expect(out.includes("--include-hook-events")).toBe(true);
    } finally {
      if (savedHookEnv === undefined) delete process.env["LOKI_HOOK_EVENTS"];
      else process.env["LOKI_HOOK_EVENTS"] = savedHookEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// v7.34.0 Phase 1: Claude session-id stamping (correlation-only).
// ---------------------------------------------------------------------------
describe("claude_flags.session-uuid (v7.34.0 Phase 1)", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it("claudeSessionUuid is a valid uuid and deterministic for the same run id", () => {
    const a = claudeSessionUuid("run-20260611-123-456");
    const b = claudeSessionUuid("run-20260611-123-456");
    expect(a).not.toBeNull();
    expect(UUID_RE.test(a as string)).toBe(true);
    expect(a).toBe(b);
  });

  it("matches the python/bash uuid.uuid5 derivation byte-for-byte (parity anchor)", () => {
    // These literals are the exact values python3 uuid.uuid5 and the bash helper
    // produce for the same namespace + name (verified during implementation).
    expect(claudeSessionUuid("run-20260611-123-456")).toBe("1c92381f-8899-58e5-b77f-d8f822f158fb");
    expect(claudeIterationSessionUuid("run-20260611-123-456", 0)).toBe("62a7de2d-bbd6-5ea7-8723-563f3b17f269");
    expect(claudeIterationSessionUuid("run-20260611-123-456", 1)).toBe("99b6d123-e400-559f-a502-6a8b7b1f923e");
  });

  it("per-iteration uuids are distinct (no pinned-run continuity leak)", () => {
    const i0 = claudeIterationSessionUuid("run-x", 0);
    const i1 = claudeIterationSessionUuid("run-x", 1);
    const stable = claudeSessionUuid("run-x");
    expect(i0).not.toBe(i1);
    expect(i0).not.toBe(stable);
  });

  it("returns null for an empty/absent run id", () => {
    const saved = process.env["LOKI_TRUST_RUN_ID"];
    delete process.env["LOKI_TRUST_RUN_ID"];
    try {
      expect(claudeSessionUuid("")).toBeNull();
      expect(claudeIterationSessionUuid("", 0)).toBeNull();
    } finally {
      if (saved === undefined) delete process.env["LOKI_TRUST_RUN_ID"];
      else process.env["LOKI_TRUST_RUN_ID"] = saved;
    }
  });

  it("sessionStampArgv default OFF -> [] (byte-identical to v7.33)", () => {
    _resetClaudeHelpCacheForTest("  --session-id <uuid>  use id");
    const saved = process.env["LOKI_SESSION_STAMP"];
    delete process.env["LOKI_SESSION_STAMP"];
    try {
      expect(sessionStampArgv("run-x", 0)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env["LOKI_SESSION_STAMP"];
      else process.env["LOKI_SESSION_STAMP"] = saved;
    }
  });

  it("sessionStampArgv with =1 emits --session-id + a distinct per-iteration uuid", () => {
    _resetClaudeHelpCacheForTest("  --session-id <uuid>  use id");
    const saved = process.env["LOKI_SESSION_STAMP"];
    process.env["LOKI_SESSION_STAMP"] = "1";
    try {
      const a = sessionStampArgv("run-x", 0);
      const b = sessionStampArgv("run-x", 1);
      expect(a[0]).toBe("--session-id");
      expect(UUID_RE.test(a[1] as string)).toBe(true);
      expect(a[1]).not.toBe(b[1]); // distinct per iteration
    } finally {
      if (saved === undefined) delete process.env["LOKI_SESSION_STAMP"];
      else process.env["LOKI_SESSION_STAMP"] = saved;
    }
  });

  it("sessionStampArgv with =1 but unsupported CLI -> [] (graceful degrade)", () => {
    _resetClaudeHelpCacheForTest("  --effort <level>  effort"); // no --session-id
    const saved = process.env["LOKI_SESSION_STAMP"];
    process.env["LOKI_SESSION_STAMP"] = "1";
    try {
      expect(sessionStampArgv("run-x", 0)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env["LOKI_SESSION_STAMP"];
      else process.env["LOKI_SESSION_STAMP"] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// v7.34.0 FIX D: --no-session-persistence (opt-in, default OFF).
// ---------------------------------------------------------------------------
describe("claude_flags.buildAutoFlags --no-session-persistence (v7.34.0 FIX D)", () => {
  it("absent by default (LOKI_NO_SESSION_PERSIST unset) -- zero behavior change", () => {
    _resetClaudeHelpCacheForTest("  --no-session-persistence  Disable session persistence");
    const saved = process.env["LOKI_NO_SESSION_PERSIST"];
    delete process.env["LOKI_NO_SESSION_PERSIST"];
    try {
      const out = buildAutoFlags({ tier: "development", primary: "opus" });
      expect(out.includes("--no-session-persistence")).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["LOKI_NO_SESSION_PERSIST"];
      else process.env["LOKI_NO_SESSION_PERSIST"] = saved;
    }
  });

  it("emitted when LOKI_NO_SESSION_PERSIST=1 and supported", () => {
    _resetClaudeHelpCacheForTest("  --no-session-persistence  Disable session persistence");
    const saved = process.env["LOKI_NO_SESSION_PERSIST"];
    process.env["LOKI_NO_SESSION_PERSIST"] = "1";
    try {
      const out = buildAutoFlags({ tier: "development", primary: "opus" });
      expect(out.includes("--no-session-persistence")).toBe(true);
    } finally {
      if (saved === undefined) delete process.env["LOKI_NO_SESSION_PERSIST"];
      else process.env["LOKI_NO_SESSION_PERSIST"] = saved;
    }
  });

  it("not emitted when =1 but CLI lacks the flag (graceful degrade)", () => {
    _resetClaudeHelpCacheForTest("  --effort <level>  effort"); // no --no-session-persistence
    const saved = process.env["LOKI_NO_SESSION_PERSIST"];
    process.env["LOKI_NO_SESSION_PERSIST"] = "1";
    try {
      const out = buildAutoFlags({ tier: "development", primary: "opus" });
      expect(out.includes("--no-session-persistence")).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["LOKI_NO_SESSION_PERSIST"];
      else process.env["LOKI_NO_SESSION_PERSIST"] = saved;
    }
  });
});

// EMBED 3b (v7.35.0, #167): --allowedTools positive review allowlist helpers.
describe("claude_flags review allowlist (EMBED 3b, #167)", () => {
  const HELP_WITH = "  --allowedTools, --allowed-tools <tools...>  allow\n  --disallowedTools <tools...>  deny";
  const HELP_WITHOUT = "  --disallowedTools <tools...>  deny"; // no --allowedTools

  let savedFlag: string | undefined;
  beforeEach(() => {
    savedFlag = process.env["LOKI_REVIEW_ALLOWLIST"];
  });
  afterEach(() => {
    if (savedFlag === undefined) delete process.env["LOKI_REVIEW_ALLOWLIST"];
    else process.env["LOKI_REVIEW_ALLOWLIST"] = savedFlag;
    _resetClaudeHelpCacheForTest(null);
  });

  it("DEFAULT ON: reviewAllowlistEnabled() true and emits the token when env unset and CLI supports the flag", () => {
    delete process.env["LOKI_REVIEW_ALLOWLIST"];
    _resetClaudeHelpCacheForTest(HELP_WITH);
    expect(reviewAllowlistEnabled()).toBe(true);
    const argv = reviewAllowlistArgv();
    expect(argv.length).toBe(2);
    expect(argv[0]).toBe("--allowedTools");
    expect(argv[1]).toBe(REVIEW_ALLOWLIST_TOKEN);
  });

  it("OPT OUT: reviewAllowlistEnabled() false and argv empty when =0 (escape hatch)", () => {
    process.env["LOKI_REVIEW_ALLOWLIST"] = "0";
    _resetClaudeHelpCacheForTest(HELP_WITH);
    expect(reviewAllowlistEnabled()).toBe(false);
    expect(reviewAllowlistArgv()).toEqual([]);
  });

  it("ON: emits --allowedTools with the token when =1 and CLI supports the flag", () => {
    process.env["LOKI_REVIEW_ALLOWLIST"] = "1";
    _resetClaudeHelpCacheForTest(HELP_WITH);
    expect(reviewAllowlistEnabled()).toBe(true);
    const argv = reviewAllowlistArgv();
    expect(argv.length).toBe(2);
    expect(argv[0]).toBe("--allowedTools");
    expect(argv[1]).toBe(REVIEW_ALLOWLIST_TOKEN);
  });

  it("graceful degrade: CLI lacks --allowedTools -> disabled even by default, argv empty", () => {
    delete process.env["LOKI_REVIEW_ALLOWLIST"];
    _resetClaudeHelpCacheForTest(HELP_WITHOUT);
    expect(reviewAllowlistEnabled()).toBe(false);
    expect(reviewAllowlistArgv()).toEqual([]);
  });

  it("token grants only read/inspect tools (Read/Grep/Glob + read-only git), never mutators", () => {
    expect(REVIEW_ALLOWLIST_TOKEN).toContain("Read");
    expect(REVIEW_ALLOWLIST_TOKEN).toContain("Grep");
    expect(REVIEW_ALLOWLIST_TOKEN).toContain("Glob");
    expect(REVIEW_ALLOWLIST_TOKEN).toContain("Bash(git diff:*)");
    expect(REVIEW_ALLOWLIST_TOKEN).toContain("Bash(git log:*)");
    expect(REVIEW_ALLOWLIST_TOKEN).toContain("Bash(git status:*)");
    // No mutation tools or git mutation forms in an ALLOW grant.
    expect(REVIEW_ALLOWLIST_TOKEN).not.toContain("Edit");
    expect(REVIEW_ALLOWLIST_TOKEN).not.toContain("Write");
    expect(REVIEW_ALLOWLIST_TOKEN).not.toContain("NotebookEdit");
    expect(REVIEW_ALLOWLIST_TOKEN).not.toContain("git push");
    expect(REVIEW_ALLOWLIST_TOKEN).not.toContain("git reset");
    expect(REVIEW_ALLOWLIST_TOKEN).not.toContain("git commit");
  });

  it("returns exactly [--allowedTools, <token>] so the token is one argv element (never swallows the -p prompt)", () => {
    process.env["LOKI_REVIEW_ALLOWLIST"] = "1";
    _resetClaudeHelpCacheForTest(HELP_WITH);
    const argv = reviewAllowlistArgv();
    // Exactly one flag + one token element. The token legitimately contains
    // spaces inside Bash(git diff:*) specifiers; what matters is that it is a
    // SINGLE array element (argv.length === 2), so when spread into the claude
    // argv the following -p prompt is never consumed as extra tool names.
    expect(argv.length).toBe(2);
    expect(argv[0]).toBe("--allowedTools");
    expect(argv[1]).toBe(REVIEW_ALLOWLIST_TOKEN);
  });
});

// Session-continuity Phase 2 (GitHub #165) -- LOKI_RESUME_SESSION recovery resume.
describe("claude_flags Phase 2 resume (#165)", () => {
  const RESUME = "LOKI_RESUME_SESSION";
  const FORK = "LOKI_SESSION_FORK";
  let savedResume: string | undefined;
  let savedFork: string | undefined;
  let savedLokiDir: string | undefined;
  let dir: string;

  beforeEach(() => {
    savedResume = process.env[RESUME];
    savedFork = process.env[FORK];
    savedLokiDir = process.env["LOKI_DIR"];
    delete process.env[RESUME];
    delete process.env[FORK];
    dir = mkdtempSync(join(tmpdir(), "loki-p2-flags-"));
    mkdirSync(join(dir, ".loki", "state"), { recursive: true });
    process.env["LOKI_DIR"] = join(dir, ".loki");
    _resetClaudeHelpCacheForTest(
      "  --session-id <uuid>\n  --resume <id>\n  --fork-session\n",
    );
  });
  afterEach(() => {
    if (savedResume === undefined) delete process.env[RESUME];
    else process.env[RESUME] = savedResume;
    if (savedFork === undefined) delete process.env[FORK];
    else process.env[FORK] = savedFork;
    if (savedLokiDir === undefined) delete process.env["LOKI_DIR"];
    else process.env["LOKI_DIR"] = savedLokiDir;
    rmSync(dir, { recursive: true, force: true });
    _resetClaudeHelpCacheForTest(null);
  });

  const seed = (uuid: string, mode = "resume") =>
    writeFileSync(
      join(dir, ".loki", "state", "claude-session.json"),
      JSON.stringify({ run_id: "r", claude_session_uuid: uuid, mode }),
    );

  it("resumeSessionEnabled default OFF; ON only with =1 + CLI support", () => {
    expect(resumeSessionEnabled()).toBe(false);
    process.env[RESUME] = "1";
    expect(resumeSessionEnabled()).toBe(true);
  });

  it("resumeSessionEnabled degrades when --resume absent from help", () => {
    _resetClaudeHelpCacheForTest("  --session-id <uuid>\n");
    process.env[RESUME] = "1";
    expect(resumeSessionEnabled()).toBe(false);
  });

  it("resumeTargetUuid reads a valid stored uuid, rejects malformed", () => {
    const u = claudeSessionUuid("run-x") as string;
    seed(u);
    expect(resumeTargetUuid(dir)).toBe(u);
    seed("not-a-uuid");
    expect(resumeTargetUuid(dir)).toBeNull();
  });

  it("resumeTargetUuid returns null when the file is absent", () => {
    expect(resumeTargetUuid(dir)).toBeNull();
  });

  it("sessionResumeArgv default OFF -> [] (byte-identical to v7.34)", () => {
    const u = claudeSessionUuid("run-x") as string;
    seed(u);
    expect(sessionResumeArgv(dir)).toEqual([]);
  });

  it("sessionResumeArgv with =1 emits --resume <stored uuid>", () => {
    const u = claudeSessionUuid("run-x") as string;
    seed(u);
    process.env[RESUME] = "1";
    expect(sessionResumeArgv(dir)).toEqual(["--resume", u]);
  });

  it("sessionResumeArgv with FORK=1 appends --fork-session", () => {
    const u = claudeSessionUuid("run-x") as string;
    seed(u);
    process.env[RESUME] = "1";
    process.env[FORK] = "1";
    expect(sessionResumeArgv(dir)).toEqual(["--resume", u, "--fork-session"]);
  });

  it("FORK without RESUME is a no-op (fork only honored with resume)", () => {
    const u = claudeSessionUuid("run-x") as string;
    seed(u);
    process.env[FORK] = "1";
    expect(sessionForkEnabled()).toBe(false);
    expect(sessionResumeArgv(dir)).toEqual([]);
  });

  it("sessionResumeArgv with =1 but malformed stored uuid -> [] (safe degrade)", () => {
    seed("not-a-uuid");
    process.env[RESUME] = "1";
    expect(sessionResumeArgv(dir)).toEqual([]);
  });
});

// P12-26: LOKI_PERMISSION_POLICY=compiled. Both routes share
// src/policies/claude_permissions.js; the bash route is exercised for parity.
describe("claude_flags.permissionArgv (P12-26)", () => {
  let repo: string;
  const SKIP = ["--dangerously-skip-permissions"];
  const noManaged = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: process.env["PATH"],
    HOME: repo,
    LOKI_MANAGED_SETTINGS: join(repo, "no-such-managed.json"),
    LOKI_WEB_POLICY: "off", // pre-w2-07 assertions pin the policy-only argv; the web defaults have their own tests below
    LOKI_PERMISSION_POLICY: "compiled",
    ...extra,
  });
  const writePolicy = (p: unknown): void => {
    mkdirSync(join(repo, ".loki"), { recursive: true });
    writeFileSync(join(repo, ".loki", "policies.json"), typeof p === "string" ? p : JSON.stringify(p));
  };
  const bashArgv = (env: NodeJS.ProcessEnv): string[] => {
    const root = join(import.meta.dir, "../../..");
    const r = Bun.spawnSync(
      ["bash", "-c", `source "${root}/providers/claude.sh" 2>/dev/null; _loki_claude_permission_argv; printf '%s\\n' "\${_LOKI_PERM_ARGV[@]}"`],
      { env: { ...env, LOKI_PROJECT_DIR: repo }, cwd: repo },
    );
    return r.stdout.toString().split("\n").filter((l) => l.length > 0);
  };
  beforeEach(() => { repo = mkdtempSync(join(tmpdir(), "perm-pol-")); });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it("C-C2: unset + operator policy present selects compiled on both routes", () => {
    writePolicy({ claude_permissions: { mode: "acceptEdits", allow: ["Read"] } }); // HOME=repo, so repo/.loki is the operator dir
    const env: NodeJS.ProcessEnv = { ...noManaged(), LOKI_PERMISSION_POLICY: "" };
    expect(permissionPolicyMode(env)).toBe("compiled");
    const ts = permissionArgv(repo, env, () => {});
    expect(ts).not.toEqual(SKIP);
    expect(ts[0]).toBe("--permission-mode");
    expect(bashArgv(env)).toEqual(ts);
    delete env["LOKI_PERMISSION_POLICY"];
    expect(permissionPolicyMode(env)).toBe("compiled");
  });

  it("C-C2: unset + no operator policy resolves legacy on both routes, with the legacy banner", () => {
    const unsetEnv: NodeJS.ProcessEnv = noManaged();
    delete unsetEnv["LOKI_PERMISSION_POLICY"];
    for (const env of [{ ...noManaged(), LOKI_PERMISSION_POLICY: "" }, unsetEnv]) {
      expect(permissionPolicyMode(env)).toBe("legacy");
      expect(permissionArgv(repo, env, () => {})).toEqual(SKIP);
      expect(bashArgv(env)).toEqual(SKIP);
      expect(permissionPolicyBanner(env)).toBe("Permission policy: legacy (no operator policy found; add one to use compiled)");
    }
  });

  it("C-C2: unset + yaml-only policy file without claude_permissions resolves legacy on both routes", () => {
    mkdirSync(join(repo, ".loki"), { recursive: true });
    writeFileSync(join(repo, ".loki", "policies.yaml"), "policies:\n  cost:\n    max: 5\n");
    const env = noManaged();
    delete env["LOKI_PERMISSION_POLICY"];
    expect(permissionPolicyMode(env)).toBe("legacy");
    expect(permissionArgv(repo, env, () => {})).toEqual(SKIP);
    expect(bashArgv(env)).toEqual(SKIP);
  });

  it("C-C2: unset + yaml-only policy file with a claude_permissions key resolves compiled (plan, yaml unsupported)", () => {
    mkdirSync(join(repo, ".loki"), { recursive: true });
    writeFileSync(join(repo, ".loki", "policies.yaml"), "policies:\n  claude_permissions:\n    mode: default\n");
    const env = noManaged();
    delete env["LOKI_PERMISSION_POLICY"];
    expect(permissionPolicyMode(env)).toBe("compiled");
    expect(permissionArgv(repo, env, () => {})).toEqual(["--permission-mode", "plan"]);
    expect(bashArgv(env)).toEqual(["--permission-mode", "plan"]);
  });

  it("C-C2: explicit compiled + no operator policy keeps fail-closed acceptEdits", () => {
    const env = noManaged();
    expect(permissionPolicyMode(env)).toBe("compiled");
    expect(permissionArgv(repo, env, () => {})).toEqual(["--permission-mode", "acceptEdits"]);
    expect(bashArgv(env)).toEqual(["--permission-mode", "acceptEdits"]);
  });

  it("C-C2: the unknown-value warning prints once per process", () => {
    resetPermissionPolicyWarning();
    const warns: string[] = [];
    const env = noManaged({ LOKI_PERMISSION_POLICY: "bogus" });
    permissionPolicyMode(env, (m) => warns.push(m));
    permissionPolicyMode(env, (m) => warns.push(m));
    expect(warns.length).toBe(1);
  });

  it("C-C2: legacy restores skip-permissions byte-identically on both routes", () => {
    const env = noManaged({ LOKI_PERMISSION_POLICY: "legacy" });
    expect(permissionPolicyMode(env)).toBe("legacy");
    expect(permissionArgv(repo, env)).toEqual(SKIP);
    expect(bashArgv(env)).toEqual(SKIP);
  });

  it("C-C2: unknown value fails closed to compiled with a warning on both routes", () => {
    writePolicy({ claude_permissions: { mode: "acceptEdits", allow: ["Read"] } });
    const env = noManaged({ LOKI_PERMISSION_POLICY: "bogus" });
    const warns: string[] = [];
    resetPermissionPolicyWarning();
    expect(permissionPolicyMode(env, (m) => warns.push(m))).toBe("compiled");
    expect(warns.some((w) => w.includes("unknown value"))).toBe(true);
    const ts = permissionArgv(repo, env, () => {});
    expect(ts).not.toEqual(SKIP);
    expect(bashArgv(env)).toEqual(ts);
  });

  it("C-C2: start banner names the active mode on both routes", () => {
    const root = join(import.meta.dir, "../../..");
    const bashBanner = (policy: string): string =>
      Bun.spawnSync(
        ["bash", "-c", `source "${root}/providers/claude.sh" 2>/dev/null; loki_permission_policy_banner`],
        { env: { PATH: process.env["PATH"], HOME: repo, LOKI_PERMISSION_POLICY: policy } },
      ).stdout.toString().trim();
    const compiled = "Permission policy: compiled (set LOKI_PERMISSION_POLICY=legacy to revert)";
    const noPol = "Permission policy: legacy (no operator policy found; add one to use compiled)";
    const envHome = { HOME: repo };
    expect(permissionPolicyBanner({ ...envHome, LOKI_PERMISSION_POLICY: "compiled" })).toBe(compiled);
    expect(permissionPolicyBanner(envHome)).toBe(noPol);
    expect(bashBanner("")).toBe(noPol);
    writePolicy({ claude_permissions: { mode: "acceptEdits" } });
    expect(permissionPolicyBanner(envHome)).toBe(compiled);
    expect(bashBanner("")).toBe(compiled);
    expect(permissionPolicyBanner({ LOKI_PERMISSION_POLICY: "legacy" })).toBe(bashBanner("legacy"));
    expect(permissionPolicyBanner({ LOKI_PERMISSION_POLICY: "legacy" })).toContain("legacy");
  });

  it("compiled: mode + allow/deny lists, identical on both routes", () => {
    writePolicy({ policies: { claude_permissions: { mode: "acceptEdits", allow: ["Read", "Bash(git diff:*)"], deny: ["Bash(rm:*)"] } } });
    const want = ["--permission-mode", "acceptEdits", "--allowedTools", "Read,Bash(git diff:*)", "--disallowedTools", "Bash(rm:*)"];
    expect(permissionArgv(repo, noManaged())).toEqual(want);
    expect(bashArgv(noManaged())).toEqual(want);
  });

  it("deny always wins over allow", () => {
    writePolicy({ claude_permissions: { mode: "default", allow: ["Read", "Bash(rm:*)"], deny: ["Bash(rm:*)"] } });
    const a = permissionArgv(repo, noManaged());
    expect(a).toEqual(["--permission-mode", "default", "--allowedTools", "Read", "--disallowedTools", "Bash(rm:*)"]);
    expect(bashArgv(noManaged())).toEqual(a);
  });

  it("managed settings cap the mode; never more permissive", () => {
    writePolicy({ claude_permissions: { mode: "bypassPermissions" } });
    const managed = join(repo, "managed.json");
    writeFileSync(managed, JSON.stringify({ permissions: { defaultMode: "default", deny: ["Bash(curl:*)"] } }));
    const env = noManaged({ LOKI_MANAGED_SETTINGS: managed });
    const want = ["--permission-mode", "default", "--disallowedTools", "Bash(curl:*)"];
    expect(permissionArgv(repo, env)).toEqual(want);
    expect(bashArgv(env)).toEqual(want);
    // a more restrictive policy is left alone
    writePolicy({ claude_permissions: { mode: "plan" } });
    expect(permissionArgv(repo, env).slice(0, 2)).toEqual(["--permission-mode", "plan"]);
  });

  it("managed disableBypassPermissionsMode caps bypass at acceptEdits", () => {
    writePolicy({ claude_permissions: { mode: "bypassPermissions" } });
    const managed = join(repo, "managed.json");
    writeFileSync(managed, JSON.stringify({ permissions: { disableBypassPermissionsMode: "disable" } }));
    expect(permissionArgv(repo, noManaged({ LOKI_MANAGED_SETTINGS: managed })).slice(0, 2)).toEqual(["--permission-mode", "acceptEdits"]);
  });

  it("invalid policy fails closed to plan with a warning, never skip-permissions", () => {
    for (const bad of ["{not json", { claude_permissions: { mode: "yolo" } }, { claude_permissions: { allow: "Read" } }]) {
      writePolicy(bad);
      const warns: string[] = [];
      const a = permissionArgv(repo, noManaged(), (m) => warns.push(m));
      expect(a).toEqual(["--permission-mode", "plan"]);
      expect(warns.length).toBe(1);
      expect(bashArgv(noManaged())).toEqual(["--permission-mode", "plan"]);
    }
  });

  it("unreadable managed settings fail closed to plan", () => {
    const managed = join(repo, "managed.json");
    writeFileSync(managed, "{broken");
    expect(permissionArgv(repo, noManaged({ LOKI_MANAGED_SETTINGS: managed }), () => {})).toEqual(["--permission-mode", "plan"]);
  });

  it("no policy: acceptEdits with a stderr warning (not default), same on bash", () => {
    const warns: string[] = [];
    expect(permissionArgv(repo, noManaged(), (m) => warns.push(m))).toEqual(["--permission-mode", "acceptEdits"]);
    expect(warns.length).toBe(1);
    expect(bashArgv(noManaged())).toEqual(["--permission-mode", "acceptEdits"]);
  });

  it("a repo policy may only narrow the operator policy, never widen it", () => {
    const home = join(repo, "operator");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "policies.json"), JSON.stringify({ claude_permissions: { mode: "default", allow: ["Read"], deny: ["Bash(curl:*)"] } }));
    writePolicy({ claude_permissions: { mode: "bypassPermissions", allow: ["Read", "Write"], deny: ["Bash(rm:*)"] } });
    const env = noManaged({ LOKI_DATA_DIR: home });
    const want = ["--permission-mode", "default", "--allowedTools", "Read", "--disallowedTools", "Bash(curl:*),Bash(rm:*)"];
    expect(permissionArgv(repo, env)).toEqual(want);
    expect(bashArgv(env)).toEqual(want);
  });

  it("a repo policy cannot widen when there is no operator policy (acceptEdits, empty allow)", () => {
    const empty = join(repo, "empty-operator");
    mkdirSync(empty, { recursive: true });
    writePolicy({ claude_permissions: { mode: "bypassPermissions", allow: ["Bash(*)"] } });
    const env = noManaged({ HOME: empty, LOKI_DATA_DIR: empty });
    const want = ["--permission-mode", "acceptEdits"];
    expect(permissionArgv(repo, env, () => {})).toEqual(want);
    expect(bashArgv(env)).toEqual(want);
  });

  it("an operator policy without allow means an empty allow list; a repo allow cannot add to it", () => {
    const home = join(repo, "operator");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "policies.json"), JSON.stringify({ claude_permissions: { mode: "default" } }));
    writePolicy({ claude_permissions: { allow: ["Bash(*)"] } });
    const env = noManaged({ LOKI_DATA_DIR: home });
    const want = ["--permission-mode", "default"];
    expect(permissionArgv(repo, env)).toEqual(want);
    expect(bashArgv(env)).toEqual(want);
  });

  it("every in-run-path claude spawn site routes through the permission helper (out of scope: benchmarks, eval, scripts)", () => {
    const root = join(import.meta.dir, "../../..");
    const lit = "--dangerously-skip-permissions";
    const live = (rel: string): string[] =>
      readFileSync(join(root, rel), "utf8").split("\n").filter((l) => l.includes(lit) && !/^\s*(#|\/\/|\*)/.test(l));
    expect(live("autonomy/run.sh").filter((l) => !l.includes("PROVIDER_AUTONOMOUS_FLAG=") && !l.includes("_LOKI_PERM_ARGV=("))).toEqual([]);
    for (const f of ["autonomy/lib/voter-agents.sh", "autonomy/lib/done-recognition.sh", "autonomy/lib/prd-enrich.sh", "autonomy/grill.sh", "autonomy/quickstart.sh"]) {
      expect(live(f).filter((l) => !l.includes("_LOKI_PERM_ARGV=("))).toEqual([]);
    }
    expect(live("loki-ts/src/runner/quality_gates.ts")).toEqual([]);
    expect(live("loki-ts/src/council/voter_agents.ts")).toEqual([]);
    expect(live("providers/claude.sh").filter((l) => !l.includes("PROVIDER_AUTONOMOUS_FLAG="))).toEqual([]);
  });

  // P12-26b guard. Exemptions are whole-line (trimmed) matches; a raw launch sharing a line with
  // an exempt shape is NOT exempt.
  const LIT = "--dangerously-skip-permissions";
  const EXACT_OK = [
    `_LOKI_PERM_ARGV=(${LIT})`,
    `PROVIDER_AUTONOMOUS_FLAG="${LIT}"`,
    `_LEGACY = ["${LIT}"]`,
  ];
  // file -> exact lines allowed only there (docs/display text, never a launch)
  const FILE_LINES: Record<string, string[]> = {
    "magic/core/debate.py": [`return ["${LIT}"]`], // import-failure fallback, only when the policy is unset
    "autonomy/loki": [`claude ${LIT}`, `echo "Flag:        ${LIT}"`],
  };
  // Whole files scoped out, with a reason. Any raw launch in them is accepted.
  const SCOPED_OUT: Record<string, string> = {
    "dashboard/build_supervisor.py": "sandboxed fixed printf readiness probe must run Bash; a policy would cause a false auth failure",
    "scripts/first-run-gate.sh": "benchmark raw-claude baseline arm and help-text stub, deliberately not policy-routed",
    "scripts/b9-scoreboard.sh": "benchmark raw-claude baseline arms and help-text stub, deliberately not policy-routed",
    "scripts/e2e-d65/stub-claude.sh": "stub claude help text only, not a launch",
    "eval/loki10/harness.py": "eval harness raw-claude baseline arm, deliberately not policy-routed",
    "benchmarks/bench/attribution.py": "benchmark raw-claude baseline arm (and its recorded command string); a policy would skew the A/B against Loki",
    "benchmarks/bench/adapters/claude_code.py": "head-to-head adapter that runs stock Claude Code as the competitor arm, not a Loki launch",
    "benchmarks/bench/adapters/codex.py": "head-to-head adapter; the flag appears only as a docstring noting parity with claude's bench arm (the workdir is a throwaway bench dir), not a Loki launch",
  };
  const rawLaunches = (rel: string, text: string): string[] =>
    text.split("\n").filter((l) => {
      if (!l.includes(LIT)) return false;
      const t = l.trim();
      if (/^(#|\/\/|\*)/.test(t)) return false;
      if (EXACT_OK.includes(t)) return false;
      if ((FILE_LINES[rel] ?? []).includes(t)) return false;
      return true;
    });

  it("P12-26b: guard flags raw launch shapes", () => {
    expect(rawLaunches("autonomy/x.sh", `claude ${LIT} -p "$prompt"`).length).toBe(1);
    expect(rawLaunches("autonomy/x.sh", `    claude ${LIT} -p "$prompt"`).length).toBe(1);
    expect(rawLaunches("autonomy/x.sh", `_LOKI_PERM_ARGV=(${LIT}); claude ${LIT} -p x`).length).toBe(1);
    expect(rawLaunches("autonomy/x.sh", `claude ${LIT}`).length).toBe(1); // heredoc line only exempt in autonomy/loki
    expect(rawLaunches("autonomy/loki", `claude ${LIT}`).length).toBe(0);
    expect(rawLaunches("autonomy/x.sh", `    _LOKI_PERM_ARGV=(${LIT})`).length).toBe(0);
  });

  it("P12-26b: no unlisted raw --dangerously-skip-permissions launch remains in autonomy/, providers/, dashboard/, magic/, scripts/, benchmarks/, eval/", () => {
    const root = join(import.meta.dir, "../../..");
    const out: string[] = [];
    const check = (r: string): void => {
      const bad = rawLaunches(r, readFileSync(join(root, r), "utf8"));
      if (bad.length && !(r in SCOPED_OUT)) out.push(`${r}: ${(bad[0] ?? "").trim().slice(0, 100)}`);
    };
    const walk = (rel: string): void => {
      for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) { if (!["node_modules", "__pycache__", "dist", ".git"].includes(e.name)) walk(r); continue; }
        if (/\.(sh|py|ts|js|mjs)$/.test(e.name) || e.name === "loki") check(r);
      }
    };
    for (const d of ["autonomy", "providers", "dashboard", "magic", "scripts", "benchmarks", "eval"]) walk(d);
    expect(out).toEqual([]);
  });

  it("P12-26c: SDK path maps the policy to permissionMode via the same resolver", () => {
    // legacy: the old default, byte-identical
    const unset = { ...noManaged(), LOKI_PERMISSION_POLICY: "legacy" };
    expect(sdkPermissionOptions(repo, unset)).toEqual({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
    // compiled restrictive policy
    writePolicy({ claude_permissions: { mode: "acceptEdits", allow: ["Read"], deny: ["Bash(rm:*)"] } });
    expect(sdkPermissionOptions(repo, noManaged())).toEqual({
      permissionMode: "acceptEdits", allowedTools: ["Read"], disallowedTools: ["Bash(rm:*)"],
    });
  });

  it("P12-26c: SDK path never widens: repo bypass under a managed cap, and fail-closed plan", () => {
    writePolicy({ claude_permissions: { mode: "bypassPermissions" } });
    const managed = join(repo, "managed.json");
    writeFileSync(managed, JSON.stringify({ permissions: { disableBypassPermissionsMode: "disable" } }));
    expect(sdkPermissionOptions(repo, noManaged({ LOKI_MANAGED_SETTINGS: managed })).permissionMode).toBe("acceptEdits");
    writePolicy("{not json");
    expect(sdkPermissionOptions(repo, noManaged(), () => {}).permissionMode).toBe("plan");
  });

  it("works from the bundled dist layout (and fails closed to plan when the compiler is absent)", () => {
    const root = join(import.meta.dir, "../../..");
    const lay = join(repo, "layout");
    mkdirSync(join(lay, "loki-ts", "dist"), { recursive: true });
    const bundle = join(lay, "loki-ts", "dist", "loki.js");
    const b = Bun.spawnSync(["bun", "build", join(root, "loki-ts/src/providers/claude_flags.ts"), "--target=bun", `--outfile=${bundle}`]);
    expect(b.exitCode).toBe(0);
    writePolicy({ claude_permissions: { mode: "acceptEdits", deny: ["Bash(rm:*)"] } });
    const probe = `import { permissionArgv } from ${JSON.stringify(bundle)}; console.log(JSON.stringify(permissionArgv(${JSON.stringify(repo)})));`;
    const run = (): string => {
      const pf = join(lay, "probe.mjs");
      writeFileSync(pf, probe);
      const r = Bun.spawnSync(["bun", pf], { env: noManaged() });
      return r.stdout.toString().trim();
    };
    // compiler absent from the layout: fail closed to plan, never skip-permissions
    expect(JSON.parse(run())).toEqual(["--permission-mode", "plan"]);
    mkdirSync(join(lay, "src", "policies"), { recursive: true });
    copyFileSync(join(root, "src/policies/claude_permissions.js"), join(lay, "src", "policies", "claude_permissions.js"));
    // the compiler also loads the shared credential-path list relative to the repo root
    mkdirSync(join(lay, "autonomy", "lib"), { recursive: true });
    copyFileSync(join(root, "autonomy/lib/secret-paths.json"), join(lay, "autonomy", "lib", "secret-paths.json"));
    expect(JSON.parse(run())).toEqual(["--permission-mode", "acceptEdits", "--disallowedTools", "Bash(rm:*)"]);
  });
});

describe("claude_flags web and credential default deny (w2-07)", () => {
  let repo: string;
  const root = join(import.meta.dir, "../../..");
  const perms = require(join(root, "src/policies/claude_permissions.js")) as {
    compile(d: string, e: NodeJS.ProcessEnv): { args: string[]; warnings: string[] };
    parseWebAllowDomains(raw: string): string[];
  };
  const baseEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: process.env["PATH"],
    HOME: repo,
    LOKI_MANAGED_SETTINGS: join(repo, "no-such-managed.json"),
    ...extra,
  });
  const bashArgv = (env: NodeJS.ProcessEnv): string[] => {
    const r = Bun.spawnSync(
      ["bash", "-c", `source "${root}/providers/claude.sh" 2>/dev/null; _loki_claude_permission_argv; printf '%s\\n' "\${_LOKI_PERM_ARGV[@]}"`],
      { env: { ...env, LOKI_PROJECT_DIR: repo }, cwd: repo },
    );
    return r.stdout.toString().split("\n").filter((l) => l.length > 0);
  };
  const denied = (argv: string[]): string[] => (argv[argv.indexOf("--disallowedTools") + 1] ?? "").split(",").filter(Boolean);
  beforeEach(() => { repo = mkdtempSync(join(tmpdir(), "web-pol-")); });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  it("default compile denies WebFetch, WebSearch and credential reads", () => {
    const d = denied(perms.compile(repo, baseEnv({ LOKI_PERMISSION_POLICY: "compiled" })).args);
    expect(d).toContain("WebFetch");
    expect(d).toContain("WebSearch");
    expect(d).toContain("Read(//**/.env*)");
    expect(d).toContain("Read(//**/.aws/**)");
    expect(d).toContain("Read(//**/.ssh/**)");
    expect(d).toContain("Read(//**/*.pem)");
  });

  it("LOKI_WEB_ALLOW_DOMAINS allows only the listed domain; non-ASCII throws", () => {
    const r = perms.compile(repo, baseEnv({ LOKI_PERMISSION_POLICY: "compiled", LOKI_WEB_ALLOW_DOMAINS: "docs.python.org" }));
    const a = r.args[r.args.indexOf("--allowedTools") + 1]!.split(",");
    expect(a).toEqual(["WebFetch(domain:docs.python.org)"]);
    expect(denied(r.args)).not.toContain("WebFetch");
    expect(denied(r.args)).toContain("WebSearch");
    expect(() => perms.parseWebAllowDomains("d\u043ccs.python.org")).toThrow(/non-ASCII/); // Cyrillic homograph
    expect(() => perms.parseWebAllowDomains("a b.com")).toThrow();
    const bad = perms.compile(repo, baseEnv({ LOKI_PERMISSION_POLICY: "compiled", LOKI_WEB_ALLOW_DOMAINS: "d\u043ccs.python.org" }));
    expect(bad.args).toEqual(["--permission-mode", "plan"]); // fails closed
  });

  it("legacy permissionArgv keeps bypass and denies WebFetch; bash argv is byte-equal", () => {
    const env = baseEnv({ LOKI_PERMISSION_POLICY: "legacy" });
    const ts = permissionArgv(repo, env, () => {});
    expect(ts[0]).toBe("--dangerously-skip-permissions");
    expect(denied(ts)).toContain("WebFetch");
    expect(bashArgv(env)).toEqual(ts);
    const c = baseEnv({ LOKI_PERMISSION_POLICY: "compiled", LOKI_WEB_ALLOW_DOMAINS: "docs.python.org" });
    expect(bashArgv(c)).toEqual(permissionArgv(repo, c, () => {}));
    expect(sdkPermissionOptions(repo, env).disallowedTools).toContain("WebSearch");
  });

  it("legacy with an allowlist still denies WebFetch (deny beats allow) and warns", () => {
    const warns: string[] = [];
    const a = permissionArgv(repo, baseEnv({ LOKI_PERMISSION_POLICY: "legacy", LOKI_WEB_ALLOW_DOMAINS: "docs.python.org" }), (m) => warns.push(m));
    expect(denied(a)).toContain("WebFetch");
    expect(warns.join("\n")).toContain("LOKI_WEB_ALLOW_DOMAINS");
  });

  it("credential deny rules are root-anchored so paths outside the repo are covered (B1)", () => {
    const cred = (argv: string[]) => denied(argv).filter((d) => d.startsWith("Read("));
    for (const argv of [
      perms.compile(repo, baseEnv({ LOKI_PERMISSION_POLICY: "compiled" })).args,
      permissionArgv(repo, baseEnv({ LOKI_PERMISSION_POLICY: "legacy" }), () => {}),
    ]) {
      expect(cred(argv).length).toBe(4);
      for (const r of cred(argv)) expect(r.startsWith("Read(//**/")).toBe(true);
      expect(cred(argv)).toContain("Read(//**/.aws/**)"); // matches /home/u/.aws/credentials, outside cwd
      expect(cred(argv).some((r) => r.startsWith("Read(**/"))).toBe(false);
    }
  });

  // Minimal model of a Claude Read rule: "//" anchors at the root, "**/" spans directories, "*" stays in one segment.
  const ruleMatches = (rule: string, path: string): boolean => {
    const g = rule.slice("Read(//".length, -1);
    const re = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, "(?:.*/)?");
    return new RegExp(`^${re}$`).test(path.replace(/^\//, ""));
  };
  const readDenied = (path: string): boolean => {
    const argvs = [
      perms.compile(repo, baseEnv({ LOKI_PERMISSION_POLICY: "compiled" })).args,
      permissionArgv(repo, baseEnv({ LOKI_PERMISSION_POLICY: "legacy" }), () => {}),
    ];
    const hits = argvs.map((a) => denied(a).some((r) => r.startsWith("Read(") && ruleMatches(r, path)));
    expect(hits[0]).toBe(hits[1]);
    return hits[0]!;
  };

  it("every .env variant that can carry a secret is denied, derived from the shipped rule", () => {
    for (const f of [".env", ".env.local", ".envrc", ".env.prod", ".env.production", ".env.staging.local", ".env.keys", ".env.vault", ".env.secrets", ".env.bak"]) {
      expect(readDenied(`/work/app/${f}`)).toBe(true);
    }
    // Templates are blocked too: a deny beats any allow, so they cannot be carved out of the glob.
    for (const f of [".env.example", ".env.sample", ".env.template"]) expect(readDenied(`/work/app/${f}`)).toBe(true);
    expect(readDenied("/home/u/.aws/credentials")).toBe(true);
    expect(readDenied("/work/app/key.pem")).toBe(true);
    expect(readDenied("/work/app/README.md")).toBe(false);
  });

  it("a punycode (xn--) allow domain is rejected and fails closed to plan", () => {
    expect(() => perms.parseWebAllowDomains("xn--80ak6aa92e.com")).toThrow(/punycode/);
    expect(() => perms.parseWebAllowDomains("docs.xn--e1afmkfd.org")).toThrow(/punycode/);
    const bad = perms.compile(repo, baseEnv({ LOKI_PERMISSION_POLICY: "compiled", LOKI_WEB_ALLOW_DOMAINS: "xn--80ak6aa92e.com" }));
    expect(bad.args).toEqual(["--permission-mode", "plan"]);
  });

  it("a punycode (xn--) allow domain fails closed to plan on the legacy route too, with a warning", () => {
    const warns: string[] = [];
    const env = baseEnv({ LOKI_PERMISSION_POLICY: "legacy", LOKI_WEB_ALLOW_DOMAINS: "docs.xn--e1afmkfd.org" });
    const argv = permissionArgv(repo, env, (m) => warns.push(m));
    expect(argv).toEqual(["--permission-mode", "plan"]);
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(warns.join("\n")).toContain("punycode");
    expect(bashArgv(env)).toEqual(argv);
  });

  it("the legacy route fails closed to plan when the policy module throws, never to allow (B2)", () => {
    const warns: string[] = [];
    const env = new Proxy(baseEnv({ LOKI_PERMISSION_POLICY: "legacy" }), {
      get(t, k) { if (k === "LOKI_WEB_POLICY") throw new Error("boom"); return (t as Record<string | symbol, unknown>)[k]; },
    });
    const argv = permissionArgv(repo, env, (m) => warns.push(m));
    expect(argv).toEqual(["--permission-mode", "plan"]);
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(warns.join("\n")).toContain("most restrictive");
  });

  it("an unusable web policy fails closed to plan with a warning on bash, python and TS alike (B2)", () => {
    const env = baseEnv({ LOKI_PERMISSION_POLICY: "legacy", LOKI_WEB_ALLOW_DOMAINS: "a b" });
    const warns: string[] = [];
    const ts = permissionArgv(repo, env, (m) => warns.push(m));
    expect(ts).toEqual(["--permission-mode", "plan"]);
    expect(warns.join("\n")).toContain("most restrictive");
    const py = Bun.spawnSync(
      ["python3", "-c", `import sys, json; sys.path.insert(0, "${root}/autonomy/lib"); from claude_permissions import claude_permission_argv; print(json.dumps(claude_permission_argv("${repo}")))`],
      { env: { ...env, LOKI_PROJECT_DIR: repo }, cwd: repo },
    );
    expect(JSON.parse(py.stdout.toString())).toEqual(ts);
    expect(py.stderr.toString()).toContain("most restrictive");
    expect(bashArgv(env)).toEqual(ts);
  });

  it("with node missing, legacy fails closed to plan with a warning on bash and python (B2)", () => {
    const empty = join(repo, "empty-bin"); mkdirSync(empty);
    const env = { ...baseEnv({ LOKI_PERMISSION_POLICY: "legacy" }), LOKI_PROJECT_DIR: repo };
    const bash = Bun.spawnSync(["/bin/bash", "-c", `source "${root}/providers/claude.sh" 2>/dev/null; PATH="${empty}"; _loki_claude_permission_argv; printf '%s\\n' "\${_LOKI_PERM_ARGV[@]}"`], { env, cwd: repo });
    expect(bash.stdout.toString().split("\n").filter(Boolean)).toEqual(["--permission-mode", "plan"]);
    expect(bash.stderr.toString()).toContain("most restrictive");
    const pyBin = Bun.which("python3")!;
    const py = Bun.spawnSync([pyBin, "-c", `import sys, json; sys.path.insert(0, "${root}/autonomy/lib"); from claude_permissions import claude_permission_argv; print(json.dumps(claude_permission_argv("${repo}")))`], { env: { ...env, PATH: empty }, cwd: repo });
    expect(JSON.parse(py.stdout.toString())).toEqual(["--permission-mode", "plan"]);
    expect(py.stderr.toString()).toContain("most restrictive");
  });

  it("LOKI_WEB_POLICY=off restores the pre-w2-07 argv; an operator allow of a web tool keeps it", () => {
    expect(permissionArgv(repo, baseEnv({ LOKI_PERMISSION_POLICY: "legacy", LOKI_WEB_POLICY: "off" }), () => {})).toEqual(["--dangerously-skip-permissions"]);
    mkdirSync(join(repo, ".loki"), { recursive: true });
    writeFileSync(join(repo, ".loki", "policies.json"), JSON.stringify({ claude_permissions: { mode: "acceptEdits", allow: ["WebFetch", "WebSearch"] } }));
    const r = perms.compile(repo, baseEnv({ LOKI_PERMISSION_POLICY: "compiled" }));
    expect(r.args[r.args.indexOf("--allowedTools") + 1]).toBe("WebFetch,WebSearch");
    expect(denied(r.args)).not.toContain("WebFetch");
    expect(denied(r.args)).not.toContain("WebSearch");
  });
});

describe("claude_flags.reviewerModelForTier (S9)", () => {
  it("routes simple and standard tiers to haiku", () => {
    for (const tier of ["simple", "standard", " SIMPLE "]) {
      expect(reviewerModelForTier({ tier, reviewer: "test-coverage-auditor", env: {} })).toBe("haiku");
    }
  });
  it("maintainer-mergeability and test-coverage-auditor are haiku at every tier, architecture-strategist is not pinned", () => {
    for (const reviewer of ["maintainer-mergeability", "test-coverage-auditor"]) {
      for (const tier of ["simple", "standard", "complex", "bogus", undefined]) {
        expect(reviewerModelForTier({ tier, reviewer, env: {} })).toBe("haiku");
      }
      expect(reviewerModelForTier({ tier: "complex", reviewer, highTier: true, env: {} })).toBe("haiku");
      expect(reviewerModelForTier({ tier: "complex", reviewer, env: { LOKI_ADVISOR_MODEL: "opus" } })).toBe("opus");
    }
    expect(reviewerModelForTier({ tier: "complex", reviewer: "architecture-strategist", env: {} })).toBeNull();
    expect(reviewerModelForTier({ tier: "simple", reviewer: "architecture-strategist", highTier: true, env: {} })).toBeNull();
  });
  it("LOKI_REVIEW_ADVISORY gates the haiku pin: 1 pins advisory reviewers, 0 restores the default, non-advisory never pinned", () => {
    for (const reviewer of ["maintainer-mergeability", "test-coverage-auditor"]) {
      expect(reviewerModelForTier({ tier: "complex", reviewer, env: { LOKI_REVIEW_ADVISORY: "1" } })).toBe("haiku");
      expect(reviewerModelForTier({ tier: "complex", reviewer, highTier: true, env: { LOKI_REVIEW_ADVISORY: "0" } })).toBeNull();
      expect(reviewerModelForTier({ tier: "complex", reviewer, env: { LOKI_REVIEW_ADVISORY: "0" } })).toBeNull();
      expect(reviewerModelForTier({ tier: "complex", reviewer, env: { LOKI_REVIEW_ADVISORY: "0", LOKI_ADVISOR_MODEL: "opus" } })).toBe("opus");
    }
    for (const v of ["1", "0"]) {
      expect(reviewerModelForTier({ tier: "complex", reviewer: "security-sentinel", env: { LOKI_REVIEW_ADVISORY: v } })).toBeNull();
    }
  });
  it("complex, unknown and absent tiers stay unpinned", () => {
    expect(reviewerModelForTier({ tier: "complex", reviewer: "a", env: {} })).toBeNull();
    expect(reviewerModelForTier({ tier: "bogus", reviewer: "a", env: {} })).toBeNull();
    expect(reviewerModelForTier({ reviewer: "a", env: {} })).toBeNull();
  });
  it("never downgrades moat reviewers or HIGH-tier changes", () => {
    expect(reviewerModelForTier({ tier: "simple", reviewer: "security-sentinel", env: {} })).toBeNull();
    expect(reviewerModelForTier({ tier: "simple", reviewer: "devils-advocate", env: {} })).toBeNull();
    expect(reviewerModelForTier({ tier: "simple", reviewer: "a", highTier: true, env: {} })).toBeNull();
  });
  it("LOKI_ADVISOR_MODEL keeps precedence; values outside haiku|sonnet|opus are ignored", () => {
    expect(reviewerModelForTier({ tier: "complex", reviewer: "a", env: { LOKI_ADVISOR_MODEL: "opus" } })).toBe("opus");
    expect(reviewerModelForTier({ tier: "simple", reviewer: "security-sentinel", env: { LOKI_ADVISOR_MODEL: "sonnet" } })).toBe("sonnet");
    expect(reviewerModelForTier({ tier: "simple", reviewer: "a", env: { LOKI_ADVISOR_MODEL: "fable" } })).toBe("haiku");
    expect(reviewerModelForTier({ tier: "complex", reviewer: "a", env: { LOKI_ADVISOR_MODEL: "fable" } })).toBeNull();
  });
  it("LOKI_REVIEWER_TIER_ROUTING=0 disables routing", () => {
    expect(reviewerModelForTier({ tier: "simple", reviewer: "a", env: { LOKI_REVIEWER_TIER_ROUTING: "0" } })).toBeNull();
  });
});

describe("claude_flags.leanReviewerFlags (S9)", () => {
  const all = () => true;
  it("tools option emits one comma-joined --tools=LIST argument; default stays empty", () => {
    const all = () => true;
    expect(leanReviewerFlags({ env: {}, flagSupported: all, tools: "Read,Bash" })).toContain("--tools=Read,Bash");
    expect(leanReviewerFlags({ env: {}, flagSupported: all })).toContain("--tools=");
  });
  it("emits --tools= as ONE argument, never --tools plus empty", () => {
    const f = leanReviewerFlags({ env: {}, flagSupported: all });
    expect(f).toContain("--tools=");
    expect(f).not.toContain("--tools");
    expect(f).not.toContain("");
  });
  it("--bare only with API key", () => {
    expect(leanReviewerFlags({ env: { ANTHROPIC_API_KEY: "k" }, flagSupported: all })).toEqual(["--bare", "--tools="]);
    const f = leanReviewerFlags({ env: {}, flagSupported: all });
    expect(f).not.toContain("--bare");
    expect(f[f.indexOf("--setting-sources") + 1]).toBe("project");
    expect(f).toContain("--strict-mcp-config");
    expect(f).toContain("--disable-slash-commands");
  });
  it("LOKI_BARE_SUBCALLS=0 disables --bare", () => {
    expect(leanReviewerFlags({ env: { ANTHROPIC_API_KEY: "k", LOKI_BARE_SUBCALLS: "0" }, flagSupported: all })).not.toContain("--bare");
  });
  it("drops unsupported flags", () => {
    const f = leanReviewerFlags({ env: {}, flagSupported: (x) => x !== "--tools" && x !== "--disable-slash-commands" });
    expect(f).not.toContain("--tools=");
    expect(f).not.toContain("--disable-slash-commands");
  });
  it("LOKI_LEAN_CHILDREN=0 disables all", () => {
    expect(leanReviewerFlags({ env: { LOKI_LEAN_CHILDREN: "0", ANTHROPIC_API_KEY: "k" }, flagSupported: all })).toEqual([]);
  });
  it("defaults to the claude help cache", () => {
    _resetClaudeHelpCacheForTest(null);
    expect(leanReviewerFlags({ env: {} })).toEqual([]);
    _resetClaudeHelpCacheForTest("--tools --setting-sources");
    expect(leanReviewerFlags({ env: {} })).toEqual(["--setting-sources", "project", "--tools="]);
    _resetClaudeHelpCacheForTest(null);
  });
});

describe("claude_flags.effortForTier bash parity (w2-06)", () => {
  const sh = join(import.meta.dir, "../../../autonomy/lib/claude-flags.sh");
  for (const tier of ["planning", "development", "fast"]) {
    for (const cx of ["standard", "complex"]) {
      it(`${tier}/${cx}: TS equals bash loki_effort_for_tier`, () => {
        const r = Bun.spawnSync(["bash", "-c", `source "${sh}"; loki_effort_for_tier ${tier} ${cx}`]);
        expect(r.exitCode).toBe(0);
        expect(String(effortForTier(tier, cx))).toBe(r.stdout.toString());
      });
    }
  }
});

describe("clampThinkingForEffort (#314)", () => {
  // The effort ceiling per thinking type, per model, from the claude-api skill model table. A model not listed has no recorded limit.
  const LIMITS: Array<[string, string]> = [["claude-opus-5", "disabled"], ["claude-haiku-5-5", "disabled"], ["claude-sonnet-5-5", "between_tools"]];
  beforeEach(() => { delete process.env["LOKI_MODEL_CATALOG"]; });
  for (const [model, type] of LIMITS) {
    it(`${model}: ${type} at xhigh and max clamps to adaptive and names the clamp`, () => {
      for (const effort of ["xhigh", "max"]) {
        const r = clampThinkingForEffort(model, { type }, effort);
        expect(r.thinking).toEqual({ type: "adaptive" });
        expect(r.clamp).toEqual({ from: type, to: "adaptive", effort, max: "high" });
      }
    });
    it(`${model}: ${type} at high or below is sent unchanged`, () => {
      for (const effort of ["low", "medium", "high"]) {
        const r = clampThinkingForEffort(model, { type }, effort);
        expect(r.thinking).toEqual({ type });
        expect(r.clamp).toBeNull();
      }
    });
    it(`${model}: adaptive is never clamped`, () => {
      expect(clampThinkingForEffort(model, { type: "adaptive" }, "max")).toEqual({ thinking: { type: "adaptive" }, clamp: null });
    });
  }
  it("a model with no recorded limit, an unknown model, and absent thinking or effort are left alone", () => {
    expect(clampThinkingForEffort("claude-sonnet-5", { type: "disabled" }, "max").clamp).toBeNull();
    expect(clampThinkingForEffort("m-unknown", { type: "disabled" }, "max").clamp).toBeNull();
    expect(clampThinkingForEffort("claude-opus-5", undefined, "max")).toEqual({ thinking: undefined, clamp: null });
    expect(clampThinkingForEffort("claude-opus-5", { type: "disabled" }, undefined).clamp).toBeNull();
  });
  it("resolves a cli alias", () => {
    expect(clampThinkingForEffort("haiku", { type: "disabled" }, "xhigh").clamp?.to).toBe("adaptive");
  });
  it("a catalog test fixture drives the limit: no max_effort, no clamp", () => {
    const cat = join(mkdtempSync(join(tmpdir(), "thinkcat-")), "cat.json");
    writeFileSync(cat, JSON.stringify({ providers: { claude: { models: [{ id: "m-a", thinking: { types: ["adaptive", "disabled"], max_effort: { disabled: "medium" } } }, { id: "m-b", thinking: { types: ["adaptive", "disabled"] } }] } } }));
    process.env["LOKI_MODEL_CATALOG"] = cat;
    expect(clampThinkingForEffort("m-a", { type: "disabled" }, "high").clamp).toEqual({ from: "disabled", to: "adaptive", effort: "high", max: "medium" });
    expect(clampThinkingForEffort("m-b", { type: "disabled" }, "high").clamp).toBeNull();
    delete process.env["LOKI_MODEL_CATALOG"];
  });
  it("thinkingConflictsEffort: disabled at xhigh or max conflicts only where the catalog records no limit", () => {
    expect(thinkingConflictsEffort("claude-sonnet-5", { type: "disabled" }, "max")).toBe(true);
    expect(thinkingConflictsEffort("m-unknown", { type: "disabled" }, "xhigh")).toBe(true);
    expect(thinkingConflictsEffort("claude-opus-5", { type: "disabled" }, "max")).toBe(false);
    expect(thinkingConflictsEffort("m-unknown", { type: "disabled" }, "high")).toBe(false);
    expect(thinkingConflictsEffort("m-unknown", { type: "adaptive" }, "max")).toBe(false);
  });
});

describe("thinking substitute and usage message (#314 follow-up)", () => {
  beforeEach(() => { delete process.env["LOKI_MODEL_CATALOG"]; });
  it("sonnet-5-5: disabled is sent as between_tools at every effort up to high, adaptive above", () => {
    for (const effort of [undefined, "low", "medium", "high"]) {
      const r = clampThinkingForEffort("claude-sonnet-5-5", { type: "disabled" }, effort);
      expect(r.thinking).toEqual({ type: "between_tools" });
      expect(r.clamp).toEqual({ from: "disabled", to: "between_tools", effort: effort ?? "default", max: "high" });
    }
    for (const effort of ["xhigh", "max"]) {
      const r = clampThinkingForEffort("claude-sonnet-5-5", { type: "disabled" }, effort);
      expect(r.thinking).toEqual({ type: "adaptive" });
      expect(r.clamp).toEqual({ from: "disabled", to: "adaptive", effort, max: "high" });
    }
  });
  it("the substitute comes from the catalog, not the model name", () => {
    const cat = join(mkdtempSync(join(tmpdir(), "thinksub-")), "cat.json");
    writeFileSync(cat, JSON.stringify({ providers: { claude: { models: [{ id: "m-s", thinking: { types: ["adaptive", "x"], substitute: { disabled: "x" } } }] } } }));
    process.env["LOKI_MODEL_CATALOG"] = cat;
    expect(clampThinkingForEffort("m-s", { type: "disabled" }, "max")).toEqual({ thinking: { type: "x" }, clamp: { from: "disabled", to: "x", effort: "max", max: "none" } });
    delete process.env["LOKI_MODEL_CATALOG"];
    expect(clampThinkingForEffort("claude-opus-5", { type: "disabled" }, "high").clamp).toBeNull();
  });
  it("thinkingConflictsEffort: a substituted model never conflicts", () => {
    expect(thinkingConflictsEffort("claude-sonnet-5-5", { type: "disabled" }, "max")).toBe(false);
  });
  it("thinkingUsageError derives the sentence from the catalog limit", () => {
    expect(thinkingUsageError("sdk-judge", "claude-opus-5")).toBe("sdk-judge: --thinking must be disabled or adaptive; for claude-opus-5 disabled is sent as adaptive above --effort high");
    expect(thinkingUsageError("sdk-text", "claude-sonnet-5-5")).toBe("sdk-text: --thinking must be disabled or adaptive; for claude-sonnet-5-5 disabled is sent as between_tools, and as adaptive above --effort high");
    expect(thinkingUsageError("sdk-judge", "claude-sonnet-5")).toBe("sdk-judge: --thinking must be disabled or adaptive, and disabled cannot combine with --effort xhigh or max for claude-sonnet-5");
  });
});

describe("thinking types are derived from the catalog for every model (#314 review)", () => {
  it("an adaptive-only model sent disabled at high is clamped to adaptive with the ledger record", () => {
    expect(clampThinkingForEffort("claude-opus-5-5", { type: "disabled" }, "high")).toEqual({
      thinking: { type: "adaptive" },
      clamp: { from: "disabled", to: "adaptive", effort: "high", max: "none" },
    });
  });

  type Spec = { types?: string[]; max_effort?: Record<string, string>; substitute?: Record<string, string> };
  const catalog = JSON.parse(readFileSync(join(import.meta.dir, "../../../providers/model_catalog.json"), "utf8"));
  const models = (catalog.providers.claude.models as Array<{ id: string; thinking?: Spec }>).filter((m) => m.thinking && Array.isArray(m.thinking.types));
  const efforts = [undefined, "low", "medium", "high", "xhigh", "max"];
  beforeEach(() => { delete process.env["LOKI_MODEL_CATALOG"]; });

  it("the catalog has adaptive-only models, so the sweep is not vacuous", () => {
    expect(models.length).toBeGreaterThan(3);
    expect(models.some((m) => m.thinking!.types!.join() === "adaptive")).toBe(true);
  });

  it("no type the CLI accepts is sent to the API unless the catalog lists it for the model", () => {
    const bad: string[] = [];
    for (const m of models) for (const type of ["disabled", "adaptive"]) for (const effort of efforts) {
      if (thinkingConflictsEffort(m.id, { type }, effort)) continue;
      const sent = clampThinkingForEffort(m.id, { type }, effort).thinking?.type;
      if (sent && !m.thinking!.types!.includes(sent)) bad.push(`${m.id} ${type}@${effort ?? "default"} -> ${sent}`);
    }
    expect(bad).toEqual([]);
  });

  it("the usage error never names a rule the model lacks", () => {
    for (const m of models) {
      const t = m.thinking!, msg = thinkingUsageError("sdk-judge", m.id), sub = t.substitute?.["disabled"];
      const disabledOk = t.types!.includes("disabled") || sub !== undefined;
      if (msg.includes("disabled or adaptive")) expect(disabledOk && t.types!.includes("adaptive")).toBe(true);
      if (msg.includes("cannot combine with --effort xhigh or max")) expect(disabledOk && !sub && !t.max_effort?.["disabled"]).toBe(true);
      if (msg.includes("above --effort")) expect(msg).toContain(`above --effort ${t.max_effort?.[sub ?? "disabled"]}`);
      if (sub) expect(msg).toContain(`sent as ${sub}`);
      if (!disabledOk) expect(msg).toContain(`disabled is not accepted by ${m.id}`);
    }
  });

  it("an adaptive-only model refuses disabled at every effort, adaptive stays accepted", () => {
    for (const m of models.filter((x) => x.thinking!.types!.join() === "adaptive")) for (const effort of efforts) {
      expect(thinkingConflictsEffort(m.id, { type: "disabled" }, effort)).toBe(true);
      expect(thinkingConflictsEffort(m.id, { type: "adaptive" }, effort)).toBe(false);
    }
  });
});
