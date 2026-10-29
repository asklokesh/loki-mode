// XV-1: default to a different vendor when one is installed (LOKI_XVENDOR_DEFAULT=1). Vendor CLIs are stubbed on a temp PATH; no real CLI runs.
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, utimesSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync as rmTree } from "node:fs";
import { acceptanceLines, acceptancePromptBlock } from "../../src/util/intent_card.ts";
import { REVIEW_ALLOWLIST_NO_GIT, REVIEW_ALLOWLIST_TOKEN, REVIEW_GUARD_DENYLIST } from "../../src/providers/claude_flags.ts";
import { sumResultCosts } from "../../src/engine10/cost.ts";
import { crossReview, hygieneFindings, ignoredPaths, minVerdict, modelReviewRan, parseReview, reviewArgv, reviewProvider, reviewReceipt } from "../../src/engine10/stages/xreview.ts";

const root = mkdtempSync(join(tmpdir(), "xv1-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function bin(names: string[]): string {
  const d = mkdtempSync(join(root, "bin-"));
  for (const n of names) { const f = join(d, n); writeFileSync(f, "#!/bin/sh\nexit 0\n"); chmodSync(f, 0o755); }
  return d;
}
const repo = mkdtempSync(join(root, "repo-"));
const on = (path: string, extra: Record<string, string> = {}) => ({ PATH: path, LOKI_XVENDOR_DEFAULT: "1", ...extra });

describe("reviewProvider XV-1", () => {
  it("builder claude + codex installed gives codex", () => expect(reviewProvider(repo, on(bin(["codex", "claude"])), "claude")).toBe("codex"));
  it("builder codex + claude installed gives claude", () => expect(reviewProvider(repo, on(bin(["codex", "claude"])), "codex")).toBe("claude"));
  it("only the builder vendor installed gives null", () => expect(reviewProvider(repo, on(bin(["claude"])), "claude")).toBeNull());
  it("flag off keeps the opt-in behaviour (null)", () => expect(reviewProvider(repo, { PATH: bin(["codex", "claude"]) }, "claude")).toBeNull());
  it("explicit review: claude with builder claude is honored", () => expect(reviewProvider(repo, on(bin(["codex"]), { LOKI_REVIEW_PROVIDER: "claude" }), "claude")).toBe("claude"));
  it("explicit off wins over the default", () => expect(reviewProvider(repo, on(bin(["codex"]), { LOKI_REVIEW_PROVIDER: "off" }), "claude")).toBeNull());
  it("LOKI_CODEX_CLI override is resolved", () => {
    const d = bin(["mycodex"]);
    expect(reviewProvider(repo, on(d, { LOKI_CODEX_CLI: "mycodex" }), "claude")).toBe("codex");
  });
});

describe("reviewReceipt XV-1", () => {
  const env = { LOKI_XVENDOR_DEFAULT: "1" };
  it("different vendor records vendor_differs true and no NOT PROVEN", () => {
    const r = reviewReceipt("claude", { provider: "codex", level: "pass", notes: [] }, env);
    expect(r.review).toEqual({ provider: "codex", vendor_differs: true, ran: "reviewer" }); expect(r.notProven).toEqual([]);
    expect(reviewReceipt("claude", { provider: "codex", level: "pass", notes: [], reviewed_by: "model", reviewer_model: "opus" }, env).review).toEqual({ provider: "codex", vendor_differs: true, ran: "reviewer (opus)", reviewer_model: "opus" });
  });
  it("explicit same vendor is flagged false with NOT PROVEN", () => {
    const r = reviewReceipt("claude", { provider: "claude", level: "pass", notes: [] }, env);
    expect(r.review).toEqual({ provider: "claude", vendor_differs: false, ran: "reviewer" }); expect(r.notProven).toEqual(["judge shares builder vendor or none configured"]);
  });
  it("no judge gives provider null and NOT PROVEN", () => {
    const r = reviewReceipt("claude", null, env);
    expect(r.review).toEqual({ provider: null, vendor_differs: false, ran: "none" }); expect(r.notProven.length).toBe(1);
  });
  it("a not_run review is not cross-vendor: vendor_differs false plus NOT PROVEN", () => {
    const r = reviewReceipt("claude", { provider: "codex", level: "not_run", notes: [] }, env);
    expect(r.review).toEqual({ provider: "codex", vendor_differs: false, ran: "none" }); expect(r.notProven).toEqual(["judge shares builder vendor or none configured"]);
  });
  it("unknown builder is never vendor_differs true", () => {
    const r = reviewReceipt("cline", { provider: "codex", level: "pass", notes: [] }, env);
    expect(r.review?.vendor_differs).toBe(false); expect(r.notProven.length).toBe(1);
  });
  it("flag off adds nothing", () => expect(reviewReceipt("claude", null, {})).toEqual({ notProven: [] }));
  it("verdict can still only be downgraded", () => {
    expect(minVerdict("VERIFIED", { provider: "codex", level: "pass", notes: [] })).toBe("VERIFIED");
    expect(minVerdict("VERIFIED", { provider: "codex", level: "block", notes: [] })).toBe("PARTIAL");
    expect(minVerdict("PARTIAL", { provider: "codex", level: "pass", notes: [] })).toBe("PARTIAL");
  });
});

describe("flag-off and CLI resolution", () => {
  it("flag off: LOKI_REVIEW_PROVIDER=off does not mask loki.yaml review", () => {
    const r = mkdtempSync(join(root, "yaml-")); writeFileSync(join(r, "loki.yaml"), "review: codex\n");
    expect(reviewProvider(r, { PATH: "", LOKI_REVIEW_PROVIDER: "off" }, "claude")).toBe("codex");
  });
  it("flag on: explicit off beats loki.yaml", () => {
    const r = mkdtempSync(join(root, "yaml-")); writeFileSync(join(r, "loki.yaml"), "review: codex\n");
    expect(reviewProvider(r, on("", { LOKI_REVIEW_PROVIDER: "off" }), "claude")).toBeNull();
  });
  it("reviewArgv spawns the same CLI vendorAvailable resolved", () => {
    expect(reviewArgv("codex", "p", { LOKI_CODEX_CLI: "mycodex" })[0]).toBe("mycodex");
    expect(reviewArgv("claude", "p", {})[0]).toBe("claude");
  });
});

describe("crossReview COST-4 risk gate", () => {
  const withTier = (tier?: string) => {
    const d = mkdtempSync(join(root, "risk-"));
    if (tier) { mkdirSync(join(d, ".loki", "state"), { recursive: true }); writeFileSync(join(d, ".loki", "state", "risk-tier.json"), JSON.stringify({ tier })); }
    return { repoDir: d, provider: "claude", baseSha: "HEAD", runDir: d } as never;
  };
  const run = async (tier?: string) => { process.env["LOKI_REVIEW_PROVIDER"] = "codex"; try { return await crossReview(withTier(tier), "VERIFIED", "HEAD"); } finally { delete process.env["LOKI_REVIEW_PROVIDER"]; } };
  it("low risk is skipped honestly, never pass", async () => {
    const r = await run("low");
    expect(r?.level).toBe("not_run"); expect(r?.notes.join(" ")).toContain("skipped: low risk");
  });
  it("stale low record from a previous run does not suppress the review", async () => {
    const c = withTier("low") as unknown as { repoDir: string; startedAtMs?: number };
    utimesSync(join(c.repoDir, ".loki", "state", "risk-tier.json"), 1, 1); c.startedAtMs = Date.now();
    process.env["LOKI_REVIEW_PROVIDER"] = "codex";
    try { expect((await crossReview(c as never, "VERIFIED", "HEAD"))?.notes.join(" ")).not.toContain("skipped: low risk"); } finally { delete process.env["LOKI_REVIEW_PROVIDER"]; }
  });
  it("medium and high still attempt the review", async () => {
    for (const t of ["medium", "high"]) expect((await run(t))?.notes.join(" ")).not.toContain("skipped: low risk");
  });
  it("unknown risk (no record) still attempts the review", async () => {
    expect((await run())?.notes.join(" ")).not.toContain("skipped: low risk");
  });
});

describe("TEN-COST-06 lean claude judge", () => {
  const sup = () => true;
  it("claude argv carries lean flags and json output", () => {
    const a = reviewArgv("claude", "p", {}, undefined, sup).join(" ");
    expect(a).toContain("--setting-sources  "); expect(a).toContain("--output-format json");
  });
  it("claude argv uses --bare with an API key", () => {
    expect(reviewArgv("claude", "p", { ANTHROPIC_API_KEY: "k" }, undefined, sup)).toContain("--bare");
  });
  it("codex argv is unchanged", () => expect(reviewArgv("codex", "p", {}, undefined, sup)).toEqual(["codex", "exec", "--sandbox", "read-only", "p"]));
  it("JSON result with BLOCK verdict parses to block", () => {
    expect(parseReview("claude", JSON.stringify({ type: "result", result: "VERDICT: BLOCK\n- x" })).level).toBe("block");
  });
  it("non-JSON claude stdout is not_run, never pass", () => {
    expect(parseReview("claude", "VERDICT: PASS").level).toBe("not_run");
    expect(parseReview("claude", "{not json").level).toBe("not_run");
  });
  it("FC-PR-BODY-PUBLIC-HYGIENE: parseReview keeps flags whole, merges headers, drops empty headers", () => {
    const long = `Missing tests: ${"the diff adds no tests for the new behaviour. ".repeat(8)}Done.`; // about 380 chars, past the old 300 cut
    const out = [
      "VERDICT: FLAG",
      `- ${long}`,
      "- Dead code in  stop-hook.sh : the check can never fire.",
      "- Acceptance lines, traced by hand because the shell output was not visible:",
      "  - 08 stops at round 8",
      "  - 010 stops at round 10",
      "- Unverified context: the state write is outside the diff. My tool output came back empty so I could not confirm it.",
      "- Trailing header with nothing under it:",
    ].join("\n");
    const notes = parseReview("claude", JSON.stringify({ result: out })).notes;
    expect(notes[0]).toBe(`cross-review flag (claude): ${long}`);
    expect(notes.some((n) => n.endsWith("not visible:"))).toBe(false);
    expect(notes.some((n) => n.includes("not visible: 08 stops at round 8; 010 stops at round 10") || (n.includes("08 stops at round 8") && n.includes("010 stops at round 10")))).toBe(true);
    expect(notes.some((n) => n.endsWith("could not confirm it."))).toBe(true);
    expect(notes.some((n) => n.includes("Trailing header"))).toBe(false);
    expect(notes).toHaveLength(4);
  });
  it("FC-PR-BODY-PUBLIC-HYGIENE: an over-cap flag ends with an ellipsis, never mid-sentence", () => {
    const n = parseReview("claude", JSON.stringify({ result: `VERDICT: FLAG\n- ${"word ".repeat(300)}` })).notes[0]!;
    expect(n.endsWith("...")).toBe(true);
    expect(n.length).toBeLessThan(700);
  });
  it("a stubbed claude run writes one xreview ledger line", async () => {
    const d = mkdtempSync(join(root, "led-")), bd = mkdtempSync(join(root, "bin-"));
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
    git("init", "-q"); writeFileSync(join(d, "a"), "1"); git("add", "a"); git("commit", "-qm", "c");
    const stub = join(bd, "claude"); writeFileSync(stub, `#!/bin/sh\nprintf '%s\n' '{"type":"result","result":"VERDICT: BLOCK\\n- x","total_cost_usd":0.01}'\n`); chmodSync(stub, 0o755);
    const ctx = { repoDir: d, provider: "codex", baseSha: "HEAD", runDir: d } as never;
    process.env["LOKI_REVIEW_PROVIDER"] = "claude"; process.env["LOKI_CLAUDE_CLI"] = stub;
    try {
      const r = await crossReview(ctx, "VERIFIED", "HEAD");
      expect(r?.level).toBe("block");
      const f = join(d, ".loki", "metrics", "child-sessions.jsonl");
      expect(existsSync(f)).toBe(true);
      const lines = readFileSync(f, "utf8").trim().split("\n"); expect(lines.length).toBe(1); expect(JSON.parse(lines[0]!).phase).toBe("xreview");
    } finally { delete process.env["LOKI_REVIEW_PROVIDER"]; delete process.env["LOKI_CLAUDE_CLI"]; }
  });
});

describe("TEN-QUALITY-13 acceptance lines in the reviewer prompt", () => {
  const card = ["Intent: add a flag", "Acceptance: --json prints valid JSON", "Out of scope: docs"];
  it("no card gives no lines and no prompt block", () => {
    expect(acceptanceLines(undefined)).toEqual([]); expect(acceptanceLines({})).toEqual([]);
    expect(acceptancePromptBlock([])).toEqual([]);
  });
  it("only Acceptance lines are extracted", () => expect(acceptanceLines({ intent_card: card })).toEqual(["Acceptance: --json prints valid JSON"]));
  it("block carries the lines and asks for UNMET", () => {
    const p = acceptancePromptBlock(acceptanceLines({ intent_card: card })).join("\n");
    expect(p).toContain("Acceptance: --json prints valid JSON"); expect(p).toContain("- UNMET: ");
  });
  it("verdict notes name the unmet line", () => {
    const r = parseReview("codex", "VERDICT: FLAG\n- UNMET: Acceptance: --json prints valid JSON");
    expect(r.notes.join(" ")).toContain("UNMET: Acceptance: --json prints valid JSON");
  });
  const stubRun = async (outputs: unknown) => {
    const d = mkdtempSync(join(root, "acc-")), bd = mkdtempSync(join(root, "bin-"));
    const sh = (...a: string[]) => Bun.spawnSync(["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
    sh("init", "-q"); writeFileSync(join(d, "a"), "1"); sh("add", "a"); sh("commit", "-qm", "c");
    const stub = join(bd, "codex"); writeFileSync(stub, `#!/bin/sh\nprintf '%s' "$*" > "${d}/argv.txt"\nprintf 'VERDICT: FLAG\\n- UNMET: Acceptance: x\\n'\n`); chmodSync(stub, 0o755);
    const ctx = { repoDir: d, provider: "claude", baseSha: "HEAD", runDir: d, ...(outputs ? { outputs: () => outputs } : {}) } as never;
    process.env["LOKI_REVIEW_PROVIDER"] = "codex"; process.env["LOKI_CODEX_CLI"] = stub;
    try { const r = await crossReview(ctx, "VERIFIED", "HEAD"); return { r, argv: readFileSync(join(d, "argv.txt"), "utf8") }; }
    finally { delete process.env["LOKI_REVIEW_PROVIDER"]; delete process.env["LOKI_CODEX_CLI"]; }
  };
  it("crossReview sends the lines through the real stub CLI and surfaces UNMET", async () => {
    const { r, argv } = await stubRun({ plan: { intent_card: ["Intent: i", "Acceptance: x"] } });
    expect(argv).toContain("Acceptance: x"); expect(r?.notes.join(" ")).toContain("UNMET: Acceptance: x");
  });
  it("no card or no outputs: prompt has no acceptance block", async () => {
    expect((await stubRun(undefined)).argv).not.toContain("UNMET: ` followed");
    expect((await stubRun({ plan: {} })).argv).not.toContain("intent card");
  });
});

describe("medium default review", () => {
  const mk = (tier: string, provider = "claude", verdictText = "VERDICT: PASS") => {
    const d = mkdtempSync(join(root, "mdr-")), bd = mkdtempSync(join(root, "mdrbin-"));
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
    git("init", "-q"); writeFileSync(join(d, "a"), "1"); git("add", "a"); git("commit", "-qm", "c");
    mkdirSync(join(d, ".loki", "state"), { recursive: true }); writeFileSync(join(d, ".loki", "state", "risk-tier.json"), JSON.stringify({ tier }));
    const stub = join(bd, provider); writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' '{"type":"result","result":"${verdictText}"}'\n`); chmodSync(stub, 0o755);
    return { ctx: { repoDir: d, provider, baseSha: "HEAD", runDir: d } as never, stub };
  };
  const withEnv = async (stub: string, extra: Record<string, string>, f: () => Promise<void>) => {
    const keys = ["LOKI_REVIEW_PROVIDER", "LOKI_XVENDOR_DEFAULT", "LOKI_CLAUDE_CLI", "LOKI_CODEX_CLI"]; const saved = keys.map((k) => process.env[k]);
    for (const k of keys) delete process.env[k];
    process.env["LOKI_CLAUDE_CLI"] = stub; process.env["LOKI_CODEX_CLI"] = stub; Object.assign(process.env, extra);
    try { await f(); } finally { keys.forEach((k, i) => { const v = saved[i]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }); }
  };
  it("medium default review: medium with nothing configured runs the run's own CLI and is marked same-vendor", async () => {
    const { ctx, stub } = mk("medium");
    await withEnv(stub, {}, async () => {
      const r = await crossReview(ctx, "VERIFIED", "HEAD");
      expect(r?.level).toBe("pass"); expect(r?.provider).toBe("claude"); expect(r?.same_vendor_default).toBe(true);
      expect(reviewReceipt("claude", r).review).toEqual({ provider: "claude", vendor_differs: false, same_vendor: true, defaulted: true, level: "pass", ran: "reviewer (sonnet)" });
    });
  });
  it("reviewer cost: one result-cost line per reviewer, the run total includes it, an unreported cost is unknown not 0", async () => {
    const { ctx } = mk("medium"), bd = mkdtempSync(join(root, "costbin-"));
    const claude = join(bd, "claude"), codex = join(bd, "codex");
    writeFileSync(claude, `#!/bin/sh\nprintf '%s\\n' '{"type":"result","result":"VERDICT: PASS","total_cost_usd":0.0123,"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":5},"modelUsage":{"claude-sonnet-x":{}}}'\n`); chmodSync(claude, 0o755);
    writeFileSync(codex, "#!/bin/sh\nprintf 'VERDICT: PASS\\n'\n"); chmodSync(codex, 0o755);
    const repoDir = (ctx as { repoDir: string }).repoDir, ids: string[] = [];
    for (const [provider, stub] of [["claude", claude], ["codex", codex]] as const) {
      await withEnv(stub, { LOKI_REVIEW_PROVIDER: provider }, async () => { const r = await crossReview({ ...(ctx as object), runId: "r1", provider: "claude" } as never, "VERIFIED", "HEAD"); ids.push(r!.cost_iteration!); });
    }
    expect(ids).toEqual(["r1-xreview-claude", "r1-xreview-codex"]);
    const lines = ids.map((i) => JSON.parse(readFileSync(join(repoDir, ".loki", "metrics", `result-cost-${i}.json`), "utf8")));
    expect(lines[0]).toMatchObject({ stage: "review", reviewer: "xreview-claude", total_cost_usd: 0.0123, input_tokens: 100, output_tokens: 20, model: "claude-sonnet-x" });
    expect(lines[1].reviewer).toBe("xreview-codex"); expect("total_cost_usd" in lines[1]).toBe(false);
    expect(sumResultCosts(join(repoDir, ".loki"), [ids[0]!]).usd).toBe(0.0123);
    const both = sumResultCosts(join(repoDir, ".loki"), ids);
    expect(both.usd).toBeNull(); expect(both.partialUsd).toBe(0.0123); expect(both.missing).toEqual(["r1-xreview-codex"]);
    expect(both.tokens_measured).toEqual({ k: 1, n: 2 }); expect(both.breakdown?.per_stage["review"]?.sessions).toBe(2);
  });
  it("medium default review: a BLOCK caps the verdict at PARTIAL", async () => {
    const { ctx, stub } = mk("medium", "claude", "VERDICT: BLOCK\\n- bad");
    await withEnv(stub, {}, async () => { expect(minVerdict("VERIFIED", await crossReview(ctx, "VERIFIED", "HEAD"))).toBe("PARTIAL"); });
  });
  it("medium default review: LOKI_REVIEW_PROVIDER=none and off opt out", async () => {
    const { ctx, stub } = mk("medium");
    for (const v of ["none", "off"]) await withEnv(stub, { LOKI_REVIEW_PROVIDER: v }, async () => { expect(await crossReview(ctx, "VERIFIED", "HEAD")).toBeNull(); });
  });
  it("medium default review: low and high tiers do not default", async () => {
    for (const t of ["low", "high"]) { const { ctx, stub } = mk(t); await withEnv(stub, {}, async () => { expect(await crossReview(ctx, "VERIFIED", "HEAD")).toBeNull(); }); }
  });
  it("medium default review: a configured reviewer keeps precedence and is not marked defaulted", async () => {
    const { ctx, stub } = mk("medium");
    await withEnv(stub, { LOKI_REVIEW_PROVIDER: "codex" }, async () => { const r = await crossReview(ctx, "VERIFIED", "HEAD"); expect(r?.provider).toBe("codex"); expect(r?.same_vendor_default).toBeUndefined(); });
  });
  // FC-XREVIEW-BLIND-TOOLS: the claude reviewer had a blanket Bash deny and a prompt inviting it to run things, so it flagged "my tool output came back empty".
  it("FC-XREVIEW-BLIND-TOOLS: claude reviewer gets the shared read-only shell allowlist and mutation denylist, not a blanket Bash deny", () => {
    const a = reviewArgv("claude", "p", {}, undefined, () => true), at = (f: string) => a[a.indexOf(f) + 1] ?? "";
    expect(at("--allowedTools")).toBe(REVIEW_ALLOWLIST_NO_GIT); expect(at("--disallowedTools")).toBe(REVIEW_GUARD_DENYLIST);
    expect(at("--allowedTools")).toContain("Bash(cat:*)"); expect(at("--disallowedTools").split(",")).not.toContain("Bash");
  });
  it("FC-XREVIEW-BLIND-TOOLS: argv never carries the empty --tools= (it disables every tool); an explicit tool list with Bash is present", () => {
    const a = reviewArgv("claude", "p", {}, undefined, () => true);
    expect(a).not.toContain("--tools=");
    expect(a).toContain("--tools=Read,Grep,Glob,Bash");
    expect(a.indexOf("--tools=Read,Grep,Glob,Bash")).toBeGreaterThan(a.indexOf("-p") + 1); // never ahead of the prompt
  });
  it("FC-XREVIEW-BLIND-TOOLS: xreview allowlist has no git entry (repo .git/config drivers run programs), shared allowlist keeps git for council", () => {
    const repo = mkdtempSync(join(tmpdir(), "loki-run-fsmon-")), marker = join(repo, "fsmon-ran");
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      writeFileSync(join(repo, ".git", "fsmon.sh"), `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(join(repo, ".git", "fsmon.sh"), 0o755);
      writeFileSync(join(repo, ".git", "config"), `[core]\n\tfsmonitor = ${join(repo, ".git", "fsmon.sh")}\n`);
      const a = reviewArgv("claude", "p", {}, undefined, () => true), allow = a[a.indexOf("--allowedTools") + 1]!.split(",");
      expect(allow.some((t) => t.startsWith("Bash(git"))).toBe(false); expect(allow).toContain("Bash(cat:*)"); expect(allow).toEqual(REVIEW_ALLOWLIST_NO_GIT.split(","));
      expect(existsSync(marker)).toBe(false); // nothing in the reviewer argv can trigger the configured fsmonitor
    } finally { rmSync(repo, { recursive: true, force: true }); }
    expect(REVIEW_ALLOWLIST_TOKEN).toContain("Bash(git status:*)"); expect(REVIEW_ALLOWLIST_TOKEN).toContain("Bash(git diff:*)");
  });
  it("FC-XREVIEW-BLIND-TOOLS: the argv the reviewer CLI really receives has no git allowlist entry, and a configured fsmonitor never runs", async () => {
    const { ctx, stub } = mk("medium"), out = join(root, "real-argv.txt"), repo = (ctx as { repoDir: string }).repoDir, marker = join(repo, "fsmon-ran");
    writeFileSync(join(repo, ".git", "fsmon.sh"), `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(join(repo, ".git", "fsmon.sh"), 0o755);
    Bun.spawnSync(["git", "-C", repo, "config", "core.fsmonitor", join(repo, ".git", "fsmon.sh")]);
    writeFileSync(stub, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${out}'\nprintf '%s\\n' '{"type":"result","result":"VERDICT: PASS"}'\n`); chmodSync(stub, 0o755);
    await withEnv(stub, {}, async () => { await crossReview(ctx, "VERIFIED", "HEAD"); });
    const argv = readFileSync(out, "utf8").split("\n"), allow = argv[argv.indexOf("--allowedTools") + 1] ?? "";
    expect(allow).toContain("Bash(cat:*)"); expect(allow).not.toContain("Bash(git"); expect(argv).toContain("--permission-mode");
    const i = argv.indexOf("--setting-sources"); if (i >= 0) expect(argv[i + 1]).toBe("");
    expect(existsSync(marker)).toBe(false);
  });
  it("FC-XREVIEW-BLIND-TOOLS: repo settings cannot widen the reviewer shell (no setting sources, dontAsk mode)", () => {
    const a = reviewArgv("claude", "p", {}, undefined, () => true);
    expect(a[a.indexOf("--setting-sources") + 1]).toBe(""); // no source: neither repo nor user settings (permissions.allow, hooks, CLAUDE.md) load expect(a[a.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  });
  it("FC-XREVIEW-BLIND-TOOLS: denylist closes the write escapes under the read-only allowlist", () => {
    const d = REVIEW_GUARD_DENYLIST.split(",");
    for (const g of ["rg --pre", "rg --pre=", "rg --pre-glob", "rg --pre-glob=", "rg --hostname-bin", "git diff --output", "git diff --output=", "git log --output", "git log --output=", "git show --output", "git show --output=", "git diff --ext-diff", "git -c", "git --exec-path", "find -delete", "find -exec"]) expect(d).toContain(`Bash(${g}:*)`);
    for (const g of ["git * --output*", "git * --ext-diff*", "rg * --pre*", "rg * --hostname-bin*", "rg --pre*", "rg --hostname-bin*", "find * -delete*", "find * -exec*"]) expect(d).toContain(`Bash(${g})`);
  });
  it("FC-XREVIEW-BLIND-TOOLS: reviewer prompt describes only real tools and never forbids reporting an inspection failure", async () => {
    const { ctx, stub } = mk("medium"), out = join(root, "blind-prompt.txt");
    writeFileSync(stub, `#!/bin/sh\nprintf '%s' "$2" > '${out}'\nprintf '%s\\n' '{"type":"result","result":"VERDICT: PASS"}'\n`);
    await withEnv(stub, {}, async () => { await crossReview(ctx, "VERIFIED", "HEAD"); });
    const p = readFileSync(out, "utf8");
    expect(p).toContain("cannot edit files or run project code or tests"); expect(p).toContain("say so plainly"); expect(p).toContain("No git commands are available"); expect(p).not.toContain("never report");
  });
});

describe("medium hygiene check and fast-tier pin", () => {
  const mkRepo = (tier: string, files: Record<string, string>, baseFiles: Record<string, string> = {}) => {
    const d = mkdtempSync(join(root, "hyg-")), bd = mkdtempSync(join(root, "hygbin-")), argvOut = join(bd, "argv.txt");
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
    git("init", "-q"); writeFileSync(join(d, "a"), "1"); git("add", "a");
    for (const [f, c] of Object.entries(baseFiles)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), c); git("--literal-pathspecs", "add", "-f", f); }
    git("commit", "-qm", "base");
    const base = new TextDecoder().decode(git("rev-parse", "HEAD").stdout).trim();
    for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), c); git("--literal-pathspecs", "add", "-f", f); }
    git("commit", "-qm", "work");
    mkdirSync(join(d, ".loki", "state"), { recursive: true }); writeFileSync(join(d, ".loki", "state", "risk-tier.json"), JSON.stringify({ tier }));
    const stub = join(bd, "claude"); writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" > '${argvOut}'\nprintf '%s\\n' '{"type":"result","result":"VERDICT: PASS"}'\n`); chmodSync(stub, 0o755);
    return { ctx: { repoDir: d, provider: "claude", baseSha: base, runDir: d } as never, stub, argvOut };
  };
  const withStub = async (stub: string, extra: Record<string, string>, f: () => Promise<void>) => {
    const keys = ["LOKI_REVIEW_PROVIDER", "LOKI_XVENDOR_DEFAULT", "LOKI_CLAUDE_CLI", "LOKI_MODEL_FAST", "LOKI_CLAUDE_MODEL_FAST", "LOKI_MODEL_OVERRIDE", "LOKI_ALLOW_HAIKU", "LOKI_CODEX_CLI", "LOKI_AGENTS_USER_DIR"], saved = keys.map((k) => process.env[k]);
    for (const k of keys) delete process.env[k];
    process.env["LOKI_CLAUDE_CLI"] = stub; Object.assign(process.env, extra);
    try { await f(); } finally { keys.forEach((k, i) => { const v = saved[i]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }); }
  };
  it("hygieneFindings flags cache and build artifacts by path, generic across stacks", () => {
    const f = hygieneFindings(["src/a.py", "pkg/__pycache__/a.cpython-311.pyc", "x.pyc", "y.pyo", "app/Main.class", "lib/a.o", "lib/a.obj", "src/build/index.ts", "pkg/build/build.go", "docs/build/conf.py", ".loki/state/x.pyc"]);
    expect(f).toEqual(["pkg/__pycache__/a.cpython-311.pyc", "x.pyc", "y.pyo", "app/Main.class", "lib/a.o", "lib/a.obj"]);
    expect(hygieneFindings(["src/a.py", "README.md"])).toEqual([]);
    expect(hygieneFindings(["web/dist/bundle.js", "src/build/index.ts"], new Set(["web/dist/bundle.js"]))).toEqual(["web/dist/bundle.js"]); // ignored by the repo's own rules
  });
  it(".class files are flagged (compiled artifact pattern)", () => expect(hygieneFindings(["out/Main.class"])).toEqual(["out/Main.class"]));
  it("legit src/build/index.ts is not flagged but an ignored dist/index.js force-added is", async () => {
    const legit = mkRepo("medium", { "src/build/index.ts": "export {}", "pkg/build/build.go": "package b" });
    const forced = mkRepo("medium", { ".gitignore": "dist/\n", "dist/index.js": "x", "src/ok.ts": "y" });
    await withStub(legit.stub, {}, async () => { const r = await crossReview(legit.ctx, "VERIFIED", "HEAD"); expect(r?.hygiene).toBeUndefined(); expect(r?.level).toBe("pass"); });
    await withStub(forced.stub, {}, async () => { const r = await crossReview(forced.ctx, "VERIFIED", "HEAD"); expect(r?.hygiene).toEqual(["dist/index.js"]); expect(r?.level).toBe("flag"); });
  });
  it("ignored files with a pathspec-magic name or a non-ASCII name are still detected, and one bad name never drops the batch", async () => {
    const { ctx, stub } = mkRepo("medium", { ".gitignore": "unicode-*\n:(exclude)x\n.env\n", ":(exclude)x": "m", "unicode-é.log": "u", ".env": "SECRET=1", "src/ok.ts": "y" });
    await withStub(stub, {}, async () => {
      const r = await crossReview(ctx, "VERIFIED", "HEAD");
      expect([...(r?.hygiene ?? [])].sort()).toEqual([":(exclude)x", ".env", "unicode-é.log"].sort()); expect(r?.level).toBe("flag");
    });
  });
  it("pre-existing tracked artifacts do not count as run-added", async () => {
    const { ctx, stub } = mkRepo("medium", { "old/x.pyc": "b2", "Old.class": "c2" }, { "old/x.pyc": "b", "Old.class": "c" }); // modified, not added, by the run
    await withStub(stub, {}, async () => {
      const r = await crossReview(ctx, "VERIFIED", "HEAD"); expect(r?.hygiene).toBeUndefined(); expect(r?.level).toBe("pass");
    });
  });
  it("hygiene observations never land in notes (so never in NOT PROVEN); the receipt carries them as observations", async () => {
    const { ctx, stub } = mkRepo("medium", { "m.pyc": "b" });
    await withStub(stub, {}, async () => {
      const r = await crossReview(ctx, "VERIFIED", "HEAD");
      expect(r?.notes.join(" ")).not.toContain("committed build"); expect(reviewReceipt("claude", r).review?.observations).toEqual(["committed build or cache artifact: m.pyc"]);
    });
  });
  const withAgent = (ctx: unknown, body: string) => { const d = (ctx as { repoDir: string }).repoDir; mkdirSync(join(d, ".loki", "agents"), { recursive: true }); writeFileSync(join(d, ".loki", "agents", "reviewer.md"), body); };
  const agentEnv = { LOKI_AGENTS_USER_DIR: "/nonexistent/agents" };
  it("an agent-configured reviewer model beats the fast-tier pin and is named on the receipt", async () => {
    const { ctx, stub, argvOut } = mkRepo("medium", { "m.py": "x=1" }); withAgent(ctx, "---\nmodel: opus\n---\nReview carefully.\n");
    await withStub(stub, agentEnv, async () => {
      const r = await crossReview(ctx, "VERIFIED", "HEAD"); const argv = readFileSync(argvOut, "utf8");
      expect(argv).toContain("--model opus"); expect(argv).not.toContain("--model sonnet"); expect(reviewReceipt("claude", r).review?.ran).toBe("reviewer (opus)");
    });
  });
  it("an agent reviewer with an empty model falls back to the pin, never to an empty model", async () => {
    const { ctx, stub, argvOut } = mkRepo("medium", { "m.py": "x=1" }); withAgent(ctx, "---\nname: rev\nmodel:\n---\nReview carefully.\n");
    await withStub(stub, agentEnv, async () => {
      const r = await crossReview(ctx, "VERIFIED", "HEAD");
      expect(readFileSync(argvOut, "utf8")).toContain("--model sonnet"); expect(r?.reviewer_model).toBe("sonnet"); expect(reviewReceipt("claude", r).review?.ran).toBe("reviewer (sonnet)");
    });
  });
  it("the receipt names an overridden reviewer model (LOKI_ALLOW_HAIKU, LOKI_MODEL_OVERRIDE)", async () => {
    const { ctx, stub } = mkRepo("medium", { "m.py": "x=1" });
    await withStub(stub, { LOKI_ALLOW_HAIKU: "true" }, async () => { expect(reviewReceipt("claude", await crossReview(ctx, "VERIFIED", "HEAD")).review?.ran).toBe("reviewer (haiku)"); });
    await withStub(stub, { LOKI_MODEL_OVERRIDE: "opus" }, async () => { expect(reviewReceipt("claude", await crossReview(ctx, "VERIFIED", "HEAD")).review?.ran).toBe("reviewer (opus)"); });
  });
  describe("cross-vendor receipt never credits a review no model finished", () => {
    for (const [name, script] of [["codex exits 1", "#!/bin/sh\nexit 1\n"], ["codex returns no VERDICT line", "#!/bin/sh\necho no verdict here\n"]] as const) {
      it(name + " after a hygiene flag: vendor_differs false and the NOT PROVEN line stays", async () => {
        const { ctx } = mkRepo("medium", { "x.pyc": "b" }), cx = join(mkdtempSync(join(root, "cxbin-")), "codex"); writeFileSync(cx, script); chmodSync(cx, 0o755);
        await withStub(cx, { LOKI_XVENDOR_DEFAULT: "1", LOKI_CODEX_CLI: cx, LOKI_CLAUDE_CLI: "/nonexistent/claude" }, async () => {
          const r = await crossReview(ctx, "VERIFIED", "HEAD"), rr = reviewReceipt("claude", r, process.env);
          expect(r?.provider).toBe("codex"); expect(r?.level).toBe("flag"); expect(r?.reviewed_by).toBe("deterministic");
          expect(rr.review?.vendor_differs).toBe(false); expect(rr.notProven).toEqual(["judge shares builder vendor or none configured"]);
        });
      });
    }
  });
  it("a committed .pyc is flagged with zero model calls", async () => {
    const { ctx, stub, argvOut } = mkRepo("medium", { "m.py": "x=1", "__pycache__/m.cpython-311.pyc": "bin" });
    await withStub(stub, { LOKI_CLAUDE_CLI: "/nonexistent/claude" }, async () => {
      const r = await crossReview(ctx, "VERIFIED", "HEAD");
      expect(r?.level).toBe("flag"); expect(r?.notes.join(" ")).not.toContain("__pycache__");
      expect(r?.hygiene).toEqual(["__pycache__/m.cpython-311.pyc"]);
    });
    await withStub(stub, {}, async () => { await crossReview(ctx, "VERIFIED", "HEAD"); });
    expect(existsSync(argvOut)).toBe(true); // control: a real stub is called only by the model path
  });
  it("medium review requests the fast tier model and a clean diff passes", async () => {
    const { ctx, stub, argvOut } = mkRepo("medium", { "m.py": "x=1" });
    await withStub(stub, {}, async () => {
      const r = await crossReview(ctx, "VERIFIED", "HEAD");
      expect(r?.level).toBe("pass"); expect(readFileSync(argvOut, "utf8")).toContain("--model sonnet");
    });
    await withStub(stub, { LOKI_CLAUDE_MODEL_FAST: "haiku" }, async () => { await crossReview(ctx, "VERIFIED", "HEAD"); expect(readFileSync(argvOut, "utf8")).toContain("--model haiku"); });
  });
  it("high tier review is not pinned to the fast tier", async () => {
    const { ctx, stub, argvOut } = mkRepo("high", { "m.py": "x=1" });
    await withStub(stub, { LOKI_REVIEW_PROVIDER: "claude" }, async () => { await crossReview(ctx, "VERIFIED", "HEAD"); expect(readFileSync(argvOut, "utf8")).not.toContain("--model"); });
  });
  it("receipt wording states what ran: model review, deterministic only, none", async () => {
    const clean = mkRepo("medium", { "m.py": "x=1" }), dirty = mkRepo("medium", { "m.py": "x=1", "a.pyc": "b" });
    await withStub(clean.stub, {}, async () => { expect(reviewReceipt("claude", await crossReview(clean.ctx, "VERIFIED", "HEAD")).review?.ran).toBe("reviewer (sonnet)"); });
    await withStub(dirty.stub, { LOKI_CLAUDE_CLI: "/nonexistent/claude" }, async () => {
      const r = await crossReview(dirty.ctx, "VERIFIED", "HEAD");
      expect(r?.level).toBe("flag"); expect(reviewReceipt("claude", r).review?.ran).toBe("deterministic check");
      expect(modelReviewRan(r)).toBe(false);
    });
    expect(reviewReceipt("claude", { provider: "claude", level: "not_run", notes: [], same_vendor_default: true }).review?.ran).toBe("none");
  });
  it("hygiene never upgrades a verdict", () => {
    expect(minVerdict("VERIFIED", { provider: "claude", level: "flag", notes: ["x"], hygiene: ["a.pyc"] })).toBe("VERIFIED");
    expect(minVerdict("PARTIAL", { provider: "claude", level: "flag", notes: [], hygiene: [] })).toBe("PARTIAL");
  });
  it("LOKI_REVIEW_PROVIDER=off still opts out of everything", async () => {
    const { ctx, stub } = mkRepo("medium", { "a.pyc": "b" });
    await withStub(stub, { LOKI_REVIEW_PROVIDER: "off" }, async () => { expect(await crossReview(ctx, "VERIFIED", "HEAD")).toBeNull(); });
  });
  // An incomplete check-ignore scan must never be credited as a deterministic hygiene pass.
  const symlinkRepo = () => {
    const r = mkRepo("medium", { ".gitignore": "*.env\n*.o\n", "a.o": "1", "lnk/x.o": "2", "zz-secret.env": "S=1" }), d = (r.ctx as { repoDir: string }).repoDir;
    rmTree(join(d, "lnk"), { recursive: true }); symlinkSync(tmpdir(), join(d, "lnk")); // working tree replaces the committed dir with a symlink
    return r;
  };
  const NP = /NOT PROVEN/;
  it("zz_c3r4_ symlink fixture: check-ignore rc=128 is unavailable, not deterministic, NOT PROVEN noted", async () => {
    const { ctx, stub } = symlinkRepo();
    await withStub(stub, { LOKI_CLAUDE_CLI: "/nonexistent/claude" }, async () => {
      const r = await crossReview(ctx, "VERIFIED", "HEAD");
      expect(r?.reviewed_by).toBe("none"); expect(r?.notes.some((n) => NP.test(n))).toBe(true);
      expect(reviewReceipt("claude", r).review?.ran).toBe("none");
    });
  });
  it("zz_c3r4_ symlink fixture with a model review: reviewed_by model, NOT PROVEN note kept", async () => {
    const { ctx, stub } = symlinkRepo();
    await withStub(stub, {}, async () => {
      const r = await crossReview(ctx, "VERIFIED", "HEAD");
      expect(r?.reviewed_by).toBe("model"); expect(r?.notes.some((n) => NP.test(n))).toBe(true);
    });
  });
  it("zz_c3r4_ path outside the repo: partial stdout with rc=128 is null", async () => {
    const { ctx } = mkRepo("medium", { ".gitignore": "*.o\n", "a.o": "1" }), d = (ctx as { repoDir: string }).repoDir;
    expect(await ignoredPaths(d, ["a.o"])).toEqual(new Set(["a.o"]));
    expect(await ignoredPaths(d, ["a.o", "../zz_c3r4_outside.o"])).toBeNull();
  });
  it("zz_c3r4_ spawn error (missing cwd) is null, not an empty set", async () => {
    expect(await ignoredPaths(join(root, "zz_c3r4_missing"), ["a.o"])).toBeNull();
  });
  it("zz_c3r4_ exit 1 (nothing ignored) is a complete empty result", async () => {
    const { ctx } = mkRepo("medium", { "src/ok.ts": "y" }), d = (ctx as { repoDir: string }).repoDir;
    expect(await ignoredPaths(d, ["src/ok.ts"])).toEqual(new Set());
  });
  it("zz_c3r4_ timeout kill is unavailable, reviewed_by none, NOT PROVEN", async () => {
    const { ctx, stub } = mkRepo("medium", { "a.pyc": "b" }), real = new TextDecoder().decode(Bun.spawnSync(["which", "git"]).stdout).trim(), gd = mkdtempSync(join(root, "zz_c3r4_git-"));
    writeFileSync(join(gd, "git"), `#!/bin/sh\ncase "$*" in *check-ignore*) exec sleep 30;; esac\nexec '${real}' "$@"\n`); chmodSync(join(gd, "git"), 0o755);
    const savedPath = process.env["PATH"];
    try {
      process.env["PATH"] = `${gd}:${savedPath}`;
      await withStub(stub, { LOKI_CLAUDE_CLI: "/nonexistent/claude", LOKI_E10_HYGIENE_BOX_MS: "300" }, async () => {
        const t0 = Date.now(), r = await crossReview(ctx, "VERIFIED", "HEAD");
        expect(Date.now() - t0).toBeLessThan(10000); expect(r?.reviewed_by).toBe("none"); expect(r?.notes.some((n) => NP.test(n))).toBe(true);
      });
    } finally { process.env["PATH"] = savedPath; delete process.env["LOKI_E10_HYGIENE_BOX_MS"]; }
  });
  it("zz_c3r5_ scan unavailable still lists a regex-caught added .pyc and stays NOT PROVEN", async () => {
    const { ctx, stub } = mkRepo("medium", { "a.pyc": "b" }), real = new TextDecoder().decode(Bun.spawnSync(["which", "git"]).stdout).trim(), gd = mkdtempSync(join(root, "zz_c3r5_git-"));
    writeFileSync(join(gd, "git"), `#!/bin/sh\ncase "$*" in *check-ignore*) exit 128;; esac\nexec '${real}' "$@"\n`); chmodSync(join(gd, "git"), 0o755);
    const savedPath = process.env["PATH"];
    try {
      process.env["PATH"] = `${gd}:${savedPath}`;
      await withStub(stub, { LOKI_CLAUDE_CLI: "/nonexistent/claude" }, async () => {
        const r = await crossReview(ctx, "VERIFIED", "HEAD");
        expect(r?.hygiene).toContain("a.pyc"); expect(r?.reviewed_by).toBe("none"); expect(r?.notes.some((n) => NP.test(n))).toBe(true);
      });
    } finally { process.env["PATH"] = savedPath; }
  });
  it("zz_c3r4_ LOKI_XVENDOR_DEFAULT=1 with no reviewer states ran none explicitly", () => {
    expect(reviewReceipt("claude", null, { LOKI_XVENDOR_DEFAULT: "1" }).review?.ran).toBe("none");
  });
});
