// XV-1: default to a different vendor when one is installed (LOKI_XVENDOR_DEFAULT=1). Vendor CLIs are stubbed on a temp PATH; no real CLI runs.
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minVerdict, reviewArgv, reviewProvider, reviewReceipt } from "../../src/engine10/stages/xreview.ts";

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
