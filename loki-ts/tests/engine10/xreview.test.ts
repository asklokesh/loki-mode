// XV-1: default to a different vendor when one is installed (LOKI_XVENDOR_DEFAULT=1). Vendor CLIs are stubbed on a temp PATH; no real CLI runs.
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, utimesSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { acceptanceLines, acceptancePromptBlock } from "../../src/util/intent_card.ts";
import { crossReview, minVerdict, parseReview, reviewArgv, reviewProvider, reviewReceipt } from "../../src/engine10/stages/xreview.ts";

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
    expect(r.review).toEqual({ provider: "codex", vendor_differs: true }); expect(r.notProven).toEqual([]);
  });
  it("explicit same vendor is flagged false with NOT PROVEN", () => {
    const r = reviewReceipt("claude", { provider: "claude", level: "pass", notes: [] }, env);
    expect(r.review).toEqual({ provider: "claude", vendor_differs: false }); expect(r.notProven).toEqual(["judge shares builder vendor or none configured"]);
  });
  it("no judge gives provider null and NOT PROVEN", () => {
    const r = reviewReceipt("claude", null, env);
    expect(r.review).toEqual({ provider: null, vendor_differs: false }); expect(r.notProven.length).toBe(1);
  });
  it("a not_run review is not cross-vendor: vendor_differs false plus NOT PROVEN", () => {
    const r = reviewReceipt("claude", { provider: "codex", level: "not_run", notes: [] }, env);
    expect(r.review).toEqual({ provider: "codex", vendor_differs: false }); expect(r.notProven).toEqual(["judge shares builder vendor or none configured"]);
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
    expect(a).toContain("--setting-sources project"); expect(a).toContain("--output-format json");
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
