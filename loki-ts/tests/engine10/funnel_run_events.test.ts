// AN-05: the run_finished pairs come from receipt.json only through an allowlist.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costBucket, modelTier, runFinishedArgs, sizeBucket, tokenBucket } from "../../src/util/funnel.ts";

let cwd = "";
const savedLokiDir = process.env["LOKI_DIR"];
beforeEach(() => {
  delete process.env["LOKI_DIR"];
  cwd = mkdtempSync(join(tmpdir(), "an05-"));
});
afterEach(() => {
  if (savedLokiDir !== undefined) process.env["LOKI_DIR"] = savedLokiDir;
  rmSync(cwd, { recursive: true, force: true });
});
const CTX = /^(provider|model_tier|lang_bucket|repo_size_bucket|test_runner|cost_bucket|token_bucket|retries)=/;
const core = (a: string[]): string[] => a.filter((p) => !CTX.test(p));
const pair = (a: string[], k: string): string | undefined => a.find((p) => p.startsWith(`${k}=`))?.slice(k.length + 1);
function receipt(body: Record<string, unknown>): void {
  const d = join(cwd, ".loki", "runs", "e10-20260101T000000-aaaa");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "receipt.json"), JSON.stringify(body));
}

describe("AN-05 runFinishedArgs", () => {
  for (const v of ["VERIFIED", "PARTIAL", "ALREADY_SATISFIED", "SPEC_CONFLICT", "FAILED"]) {
    test(`receipt verdict ${v} is the reported verdict`, () => {
      receipt({ verdict: v, time: { wall_s: 10, stages: { wall: 3, implement: 5.4 } }, cost: { fix_rounds: [{}, {}, {}] } });
      expect(core(runFinishedArgs(1, cwd))).toEqual([v, "duration_s=10", "stage_s_wall=3", "stage_s_implement=5", "fix_rounds=3", "exit_code=1"]);
    });
  }
  test("no receipt is INTERRUPTED, and exit 4 without one is BLOCKED", () => {
    expect(core(runFinishedArgs(1, cwd))).toEqual(["INTERRUPTED", "exit_code=1"]);
    expect(core(runFinishedArgs(4, cwd))).toEqual(["BLOCKED", "exit_code=4"]);
  });
  test("a receipt older than this run is not this run's receipt", () => {
    receipt({ verdict: "VERIFIED" });
    expect(runFinishedArgs(0, cwd, Date.now() + 60_000)[0]).toBe("INTERRUPTED");
  });
  test("an out-of-enum verdict and injected extra keys never reach the pairs", () => {
    receipt({ verdict: "/Users/x/secret", repo: "/Users/x/repo", spec_conflict_reason: "secret text", time: { wall_s: 5, stages: { "wall+implement": 4, "/etc/passwd": 9 } } });
    expect(core(runFinishedArgs(1, cwd))).toEqual(["INTERRUPTED", "exit_code=1"]);
    receipt({ verdict: "FAILED", repo: "/Users/x/repo", spec_conflict_reason: "secret text", time: { wall_s: 5, stages: { "wall+implement": 4, "/etc/passwd": 9 } } });
    const out = runFinishedArgs(1, cwd);
    expect(core(out)).toEqual(["FAILED", "duration_s=5", "exit_code=1"]);
    expect(JSON.stringify(out)).not.toContain("secret");
  });
  test("a corrupt receipt is INTERRUPTED, never a throw", () => {
    const d = join(cwd, ".loki", "runs", "e10-20260101T000000-aaaa");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "receipt.json"), "{not json");
    expect(runFinishedArgs(1, cwd)[0]).toBe("INTERRUPTED");
  });
});

describe("AN-06 run context buckets", () => {
  const write = (rel: string, text = "x = 1\n"): void => { mkdirSync(join(cwd, rel, ".."), { recursive: true }); writeFileSync(join(cwd, rel), text); };
  test("a python repo gives lang python and runner pytest", () => {
    write("app.py", "def f():\n    return 1\n".repeat(20));
    write("test_app.py", "def test_f():\n    assert True\n");
    receipt({ verdict: "VERIFIED", provider: "claude", model: "claude-sonnet-4-5", cost: { usd: 0.4, input_tokens: 50000, output_tokens: 1000 } });
    const out = runFinishedArgs(0, cwd);
    expect(pair(out, "lang_bucket")).toBe("python");
    expect(pair(out, "test_runner")).toBe("pytest");
    expect(pair(out, "repo_size_bucket")).toBe("xs");
    expect(pair(out, "provider")).toBe("claude");
    expect(pair(out, "model_tier")).toBe("balanced");
    expect(pair(out, "cost_bucket")).toBe("lt_1");
    expect(pair(out, "token_bucket")).toBe("lt_100k");
    expect(pair(out, "retries")).toBe("0");
  });
  test("no path, file name or repo name appears anywhere in the serialized event", () => {
    write("secret_project_name/module_xyz.py");
    write("secret_project_name/test_module_xyz.py");
    receipt({ verdict: "FAILED", provider: "/Users/x/prov", model: "/Users/x/model", repo: "/Users/x/repo", cost: { usd: 2, input_tokens: 1, output_tokens: 1, source: "/Users/x/src", per_model: { "/Users/x/m": {} } }, failover: [{ stage: "/Users/x/s" }] });
    const args = runFinishedArgs(1, cwd);
    const text = JSON.stringify(args);
    for (const bad of ["secret_project_name", "module_xyz", "/Users", "an05-", cwd]) expect(text).not.toContain(bad);
    for (const p of args.slice(1)) expect(p).toMatch(/^[a-z_0-9]+=[A-Za-z_0-9]+$/);
    expect(pair(args, "provider")).toBe("other");
    const lists: Record<string, string[]> = { lang_bucket: ["python", "javascript", "typescript", "go", "rust", "java", "ruby", "php", "csharp", "c_cpp", "shell", "other"], repo_size_bucket: ["xs", "s", "m", "l", "xl"], test_runner: ["pytest", "unittest", "vitest", "jest", "npm", "bun", "node", "go", "cargo", "maven", "gradle", "javac", "none", "unknown"], model_tier: ["fast", "balanced", "deep", "mixed", "unknown"], cost_bucket: ["lt_1", "lt_5", "lt_20", "ge_20", "unknown"], token_bucket: ["lt_100k", "lt_1m", "lt_10m", "ge_10m", "unknown"] };
    for (const [k, vals] of Object.entries(lists)) expect(vals).toContain(pair(args, k) as string);
  });
  test("a null or missing cost is unknown, never 0", () => {
    receipt({ verdict: "VERIFIED", provider: "claude", cost: { usd: null, input_tokens: 0, output_tokens: 0 } });
    const out = runFinishedArgs(0, cwd);
    expect(pair(out, "cost_bucket")).toBe("unknown");
    expect(pair(out, "token_bucket")).toBe("unknown");
    receipt({ verdict: "VERIFIED" });
    expect(pair(runFinishedArgs(0, cwd), "cost_bucket")).toBe("unknown");
    expect(costBucket(null)).toBe("unknown");
    expect(costBucket(0, "cli-invoker-unmetered")).toBe("unknown");
    expect(pair(runFinishedArgs(1, cwd, Date.now() + 60_000), "cost_bucket")).toBe("unknown");
  });
  test("bucket edges: one value on each side of every edge", () => {
    expect([49, 50, 499, 500, 4999, 5000, 49999, 50000].map(sizeBucket)).toEqual(["xs", "s", "s", "m", "m", "l", "l", "xl"]);
    expect([0.01, 0.99, 1, 4.99, 5, 19.99, 20].map((v) => costBucket(v))).toEqual(["lt_1", "lt_1", "lt_5", "lt_5", "lt_20", "lt_20", "ge_20"]);
    expect([1, 99999, 100000, 999999, 1e6, 9999999, 1e7].map((a) => tokenBucket(a, 0))).toEqual(["lt_100k", "lt_100k", "lt_1m", "lt_1m", "lt_10m", "lt_10m", "ge_10m"]);
    expect(tokenBucket(5, 5, true)).toBe("unknown");
    expect(modelTier("claude-haiku-4-5")).toBe("fast");
    expect(modelTier("claude-opus-4-1")).toBe("deep");
    expect(modelTier("x", { "claude-haiku-4-5": {}, "claude-opus-4-1": {} })).toBe("mixed");
    expect(modelTier("totally-unknown-model")).toBe("unknown");
  });
  test("an unknown or injected value is never sent: every context pair is from its fixed list", () => {
    receipt({ verdict: "VERIFIED", provider: "evil provider", model: "claude-sonnet-4-5; injected", cost: { usd: "5", input_tokens: "9", output_tokens: 1 }, failover: "yes" });
    const out = runFinishedArgs(0, cwd);
    expect(pair(out, "provider")).toBe("other");
    expect(pair(out, "cost_bucket")).toBe("unknown");
    expect(pair(out, "token_bucket")).toBe("unknown");
    expect(pair(out, "retries")).toBe("0");
    expect(out.join(" ")).not.toContain("evil");
  });
});
