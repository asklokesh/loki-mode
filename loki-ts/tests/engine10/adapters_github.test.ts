// loki-ts/tests/engine10/adapters_github.test.ts
//
// E-25 wall check. fetchIssue is exercised through a fake Execer (never a
// real gh/bash call); openPr is exercised through a stub push script (never
// the real, credentialed autonomy/lib/engine10-push.sh).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PUSH_SH, makeGithubAdapter } from "../../src/engine10/adapters/github.ts";
import { adapters, matchAdapter } from "../../src/engine10/adapters/index.ts";
import type { Execer } from "../../src/engine10/fetch_issue.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "adapters-github");
const PR_URL = "https://github.com/octocat/hello/pull/42";

function fixtureExecer(): Execer {
  return (cmd: string, args: string[]): string => {
    if (cmd === "bash") return readFileSync(join(FIXTURES, "issue-raw.json"), "utf8");
    if (cmd === "gh") return readFileSync(join(FIXTURES, "issue-extra.json"), "utf8");
    throw new Error(`unexpected exec in test: ${cmd} ${args.join(" ")}`);
  };
}

describe("github adapter: matches()", () => {
  const adapter = makeGithubAdapter();

  test.each([
    "acme/widgets#52",
    "https://github.com/acme/widgets/issues/52",
    "#52",
    "52",
  ])("accepts %s", (ref) => {
    expect(adapter.matches?.(ref)).toBe(true);
  });

  test.each([
    "PROJ-123",
    "https://gitlab.com/acme/widgets/-/issues/52",
    "https://github.com/acme/widgets/pull/52",
  ])("rejects %s", (ref) => {
    expect(adapter.matches?.(ref)).toBe(false);
  });

  test("registry: matchAdapter finds the github adapter and only it is registered", () => {
    expect(adapters).toHaveLength(1);
    expect(matchAdapter("acme/widgets#52")?.name).toBe("github");
    expect(matchAdapter("PROJ-123")).toBeNull();
  });
});

describe("github adapter: fetchIssue", () => {
  test("the fixture issue normalizes", async () => {
    const adapter = makeGithubAdapter({ execer: fixtureExecer() });
    const issue = await adapter.fetchIssue!("acme/widgets#52");

    expect(issue).toEqual({
      provider: "github",
      number: 52,
      title: "add a search bar",
      body: "Add a search bar to the header nav.",
      labels: ["enhancement"],
      author: "octocat",
      url: "https://github.com/acme/widgets/issues/52",
      created_at: "2026-01-15T10:00:00Z",
      repo: "acme/widgets",
      state: "open", // lowercased from the fixture's "OPEN"
      closed_by_merged_pr: false,
    });
  });
});

describe("github adapter: openPr", () => {
  let stubDir: string;
  let logPath: string;
  let canaryPath: string;

  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), "e10-gh-adapter-stub-"));
    logPath = join(stubDir, "calls.log");
    canaryPath = join(stubDir, "CANARY");
  });

  afterEach(() => {
    rmSync(stubDir, { recursive: true, force: true });
  });

  /** Logs argv verbatim; never evaluates it. A canary in the title (e.g. a
   *  `$(touch ...)` command substitution) proves argv-only when CANARY is
   *  never created: engine10-push.sh's own argv handling never re-invokes
   *  a shell over its arguments, and neither must this adapter. */
  function writeStub(): string {
    const scriptPath = join(stubDir, "push-stub.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/sh
mode="$1"; shift
printf 'CALL mode=%s argc=%s\\n' "$mode" "$#" >> "${logPath}"
for a in "$@"; do printf 'ARG %s\\n' "$a" >> "${logPath}"; done
[ "$mode" = "push-pr" ] && echo "${PR_URL}"
exit 0
`,
      { mode: 0o755 },
    );
    return scriptPath;
  }

  test("openPr calls engine10-push.sh with argv only (no --draft)", async () => {
    const script = writeStub();
    const adapter = makeGithubAdapter({ pushScriptPath: script });
    const result = await adapter.openPr!({
      repoDir: "/tmp/repo",
      branch: "loki/e10-test",
      title: "add a search bar",
      bodyFile: "/tmp/repo/pr-body.md",
      draft: false,
    });

    expect(result).toEqual({ url: PR_URL, draft: false });
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("CALL mode=push-pr argc=4");
    expect(log).not.toContain("--draft");
  });

  test("draft: true appends --draft as its own argv element", async () => {
    const script = writeStub();
    const adapter = makeGithubAdapter({ pushScriptPath: script });
    const result = await adapter.openPr!({
      repoDir: "/tmp/repo",
      branch: "loki/e10-test",
      title: "add a search bar",
      bodyFile: "/tmp/repo/pr-body.md",
      draft: true,
    });

    expect(result.draft).toBe(true);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("CALL mode=push-pr argc=5");
    expect(log).toContain("ARG --draft");
  });

  test("a hostile title reaches the stub as one literal argv element, never a shell (argv only)", async () => {
    const script = writeStub();
    const adapter = makeGithubAdapter({ pushScriptPath: script });
    const hostileTitle = `add a search bar\`; touch ${canaryPath}; #\` $(touch ${canaryPath})`;
    await adapter.openPr!({
      repoDir: "/tmp/repo",
      branch: "loki/e10-test",
      title: hostileTitle,
      bodyFile: "/tmp/repo/pr-body.md",
      draft: false,
    });

    expect(existsSync(canaryPath)).toBe(false);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain(`ARG ${hostileTitle}`);
  });

  test("default push script path matches stages/pr.ts's real script", () => {
    expect(DEFAULT_PUSH_SH.endsWith("/autonomy/lib/engine10-push.sh")).toBe(true);
  });

  test("a failing stub throws with its stderr", async () => {
    const scriptPath = join(stubDir, "fail-stub.sh");
    writeFileSync(scriptPath, `#!/bin/sh\necho "stub: refused" >&2\nexit 2\n`, { mode: 0o755 });
    const adapter = makeGithubAdapter({ pushScriptPath: scriptPath });

    await expect(
      adapter.openPr!({ repoDir: "/tmp/repo", branch: "b", title: "t", bodyFile: "/tmp/repo/b.md", draft: false }),
    ).rejects.toThrow(/stub: refused/);
  });
});
