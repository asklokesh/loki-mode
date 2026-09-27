// E-26: GitLab adapter. A stub glab on PATH serves the fixture issue to the
// real issue-providers.sh; the push child is either a fake runner (argv
// contract) or the real script refusing a non-gitlab.com pin. No network.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitlabAdapter, PUSH_GITLAB_SH, type PushRunner } from "../../src/engine10/adapters/gitlab.ts";

const FIXTURE = join(import.meta.dir, "fixtures/adapters-gitlab/issue.json");
const dir = mkdtempSync(join(tmpdir(), "loki-e10-gl-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "glab"), `#!/bin/sh\necho "$*" >> "${dir}/glab.log"\ncat "${FIXTURE}"\n`);
chmodSync(join(dir, "glab"), 0o755);
const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, LOKI_NO_BROWSER: "1" };
const exec = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", env });

const REQ = { repoDir: "/r", branch: "loki/e10-fix", title: "T", bodyFile: "/b.md", draft: true };

describe("gitlab adapter", () => {
  test("the fixture issue normalizes through issue-providers.sh", async () => {
    const issue = await gitlabAdapter({ exec }).fetchIssue!("https://gitlab.com/grp/sub/proj/-/issues/42");
    expect(issue).toEqual({
      provider: "gitlab", number: 42, title: "Fix the flaky parser",
      body: "The parser drops the last token.\n\nSteps: run parse.", labels: ["bug", "parser"],
      author: "octo", url: "https://gitlab.com/grp/sub/proj/-/issues/42", created_at: "2026-09-01T10:00:00Z",
      repo: "grp/sub/proj", state: null, closed_by_merged_pr: false,
    });
    expect(readFileSync(join(dir, "glab.log"), "utf8")).toContain("issue view 42 --repo grp/sub/proj --output json");
  });

  test("matches gitlab issue URLs only; a non-gitlab provider is rejected", async () => {
    const a = gitlabAdapter({ exec: () => JSON.stringify({ provider: "github" }) });
    expect(a.matches!("https://gitlab.com/grp/proj/-/issues/3")).toBe(true);
    expect(a.matches!("https://github.com/o/r/issues/3")).toBe(false);
    await expect(a.fetchIssue!("x")).rejects.toThrow("provider github");
  });

  test("openPr runs engine10-push-gitlab.sh with argv only and the pin in env", async () => {
    const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const run: PushRunner = (cmd, args, e) => {
      calls.push({ cmd, args, env: e });
      return { status: 0, stdout: "https://gitlab.com/grp/proj/-/merge_requests/7\n", stderr: "" };
    };
    const pin = "https://gitlab.com/grp/proj.git";
    const out = await gitlabAdapter({ pinnedOrigin: pin, run }).openPr!(REQ);
    expect(out).toEqual({ url: "https://gitlab.com/grp/proj/-/merge_requests/7", draft: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("bash");
    expect(calls[0]!.args).toEqual([PUSH_GITLAB_SH, "push-mr", "/r", "loki/e10-fix", "T", "/b.md", "--draft"]);
    expect(calls[0]!.env._LOKI_ORIGIN_PINNED).toBe("1");
    expect(calls[0]!.env._LOKI_PINNED_ORIGIN).toBe(pin);
  });

  test("openPr refuses without a pin and surfaces a failed push", async () => {
    await expect(gitlabAdapter({ run: () => ({ status: 0, stdout: "", stderr: "" }) }).openPr!(REQ)).rejects.toThrow("no pinned origin");
    const fail: PushRunner = () => ({ status: 2, stdout: "", stderr: "pinned origin refused" });
    await expect(gitlabAdapter({ pinnedOrigin: "https://gitlab.com/g/p.git", run: fail }).openPr!(REQ)).rejects.toThrow("pinned origin refused");
  });

  test("the real push child refuses a non-gitlab.com pin", async () => {
    const a = gitlabAdapter({ pinnedOrigin: "https://gitlab.example.com/grp/proj.git" });
    await expect(a.openPr!({ ...REQ, repoDir: dir, bodyFile: FIXTURE })).rejects.toThrow("pinned origin refused");
  });
});
