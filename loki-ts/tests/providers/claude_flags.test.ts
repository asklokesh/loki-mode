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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effortForTier,
  remainingBudget,
  fallbackForPrimary,
  claudeFlagSupported,
  buildAutoFlags,
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
} from "../../src/providers/claude_flags.ts";

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
    writeFileSync(join(td, ".loki", "metrics", "budget.json"), JSON.stringify({ current_spend: 12.34 }));
    expect(remainingBudget(td)).toBe("37.66");
  });
  it("returns null when overspent (never emits 0 or negative)", () => {
    process.env["LOKI_BUDGET_LIMIT"] = "50";
    writeFileSync(join(td, ".loki", "metrics", "budget.json"), JSON.stringify({ current_spend: 60.0 }));
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
    writeFileSync(join(td, ".loki", "metrics", "budget.json"), JSON.stringify({ current_spend: 100 }));
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

  it("DEFAULT OFF: reviewAllowlistEnabled() false and argv empty when env unset", () => {
    delete process.env["LOKI_REVIEW_ALLOWLIST"];
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

  it("graceful degrade: =1 but CLI lacks --allowedTools -> disabled, argv empty", () => {
    process.env["LOKI_REVIEW_ALLOWLIST"] = "1";
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
