import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultExec, fetchIssue } from "../../src/engine10/fetch_issue.ts";

const BASE = { provider: "gitlab", repo: "", number: 0, title: "t", body: "", labels: [], author: "a", url: "u", created_at: "c" };

function withTimeoutEnv<T>(ms: string, fn: () => T): T {
  const prev = process.env.LOKI_FETCH_ISSUE_TIMEOUT_MS;
  process.env.LOKI_FETCH_ISSUE_TIMEOUT_MS = ms;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.LOKI_FETCH_ISSUE_TIMEOUT_MS;
    else process.env.LOKI_FETCH_ISSUE_TIMEOUT_MS = prev;
  }
}

describe("fetch_issue timeout", () => {
  test("timeout: defaultExec kills a hung child and throws", () => {
    const t0 = Date.now();
    withTimeoutEnv("300", () => {
      expect(() => defaultExec("sleep", ["30"])).toThrow();
    });
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  test("timeout: fetchIssue through default exec surfaces a hung bash as a throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "fi-timeout-"));
    const prevPath = process.env.PATH;
    try {
      writeFileSync(join(dir, "bash"), "#!/bin/sh\nexec sleep 30\n");
      chmodSync(join(dir, "bash"), 0o755);
      process.env.PATH = `${dir}:${prevPath}`;
      const t0 = Date.now();
      withTimeoutEnv("300", () => {
        expect(() => fetchIssue("owner/repo#1")).toThrow();
      });
      expect(Date.now() - t0).toBeLessThan(10_000);
    } finally {
      process.env.PATH = prevPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("injected Execer path unchanged; failed gh lookup leaves state null", () => {
    const gh = JSON.stringify({ ...BASE, provider: "github", repo: "o/r", number: 3 });
    const calls: string[] = [];
    const issue = fetchIssue("o/r#3", (cmd) => {
      calls.push(cmd);
      if (cmd === "bash") return gh;
      throw new Error("ETIMEDOUT");
    });
    expect(calls).toEqual(["bash", "gh"]);
    expect(issue.state).toBeNull();
    expect(issue.closed_by_merged_pr).toBe(false);
  });
});
