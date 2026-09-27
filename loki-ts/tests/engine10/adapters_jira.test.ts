// loki-ts/tests/engine10/adapters_jira.test.ts
//
// E-27 wall check. No network: `execer` is faked so fetch_jira_issue's real
// curl call never runs. fixtures/adapters-jira/issue.json is the shape
// fetch_jira_issue's python normalizer already produces (verified against
// autonomy/issue-providers.sh:321-345).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createJiraAdapter, fetchIssue, jiraAdapter, matchesJira } from "../../src/engine10/adapters/jira.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "adapters-jira", "issue.json");
const RAW = readFileSync(FIXTURE, "utf8");
const EXPECTED = JSON.parse(RAW);

describe("engine10 jira adapter", () => {
  test("matches Jira keys and browse URLs, not other refs", () => {
    expect(matchesJira("PROJ-123")).toBe(true);
    expect(matchesJira("https://example.atlassian.net/browse/PROJ-123")).toBe(true);
    expect(matchesJira("owner/repo#123")).toBe(false);
    expect(matchesJira("https://github.com/owner/repo/issues/123")).toBe(false);
  });

  test("fetchIssue normalizes the fixture with no network call", () => {
    let seenCmd = "";
    let seenRef = "";
    const fake = (cmd: string, args: string[]) => {
      seenCmd = cmd;
      seenRef = args[args.length - 1] ?? "";
      return RAW;
    };
    const issue = fetchIssue("PROJ-123", fake);
    expect(seenCmd).toBe("bash");
    expect(seenRef).toBe("PROJ-123");
    expect(issue).toEqual(EXPECTED);
  });

  test("the adapter has no write path: no openPr, no notify", () => {
    expect(jiraAdapter.name).toBe("jira");
    expect(jiraAdapter.openPr).toBeUndefined();
    expect(jiraAdapter.notify).toBeUndefined();
  });

  test("the adapter's fetchIssue wraps the same fixture, with no network call", async () => {
    const fake = (_cmd: string, _args: string[]) => RAW;
    const adapter = createJiraAdapter(fake);
    const issue = await adapter.fetchIssue!("PROJ-123");
    expect(issue).toEqual(EXPECTED);
  });

  test("jiraAdapter (the default export) is a real Adapter, not a stub", () => {
    expect(jiraAdapter.name).toBe("jira");
    expect(typeof jiraAdapter.fetchIssue).toBe("function");
  });
});
