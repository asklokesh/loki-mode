import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { commentText, writeBack } from "../../src/integrations/writeback.ts";

type Call = { url: string; body: string };
let calls: Call[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const base = { verdict: "VERIFIED", prUrl: "https://github.com/a/b/pull/1", receiptSha256: "abc", task: "" };
const jiraEnv = { JIRA_BASE_URL: "https://acme.atlassian.net", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" };

describe("writeback phases", () => {
  it("comment text differs per phase", () => {
    const t = (phase: "started" | "blocked" | "done" | "failed") => commentText({ ...base, phase, reason: "why" });
    expect(new Set([t("started"), t("blocked"), t("done"), t("failed")]).size).toBe(4);
    expect(t("blocked")).toContain("why");
    expect(t("done")).toContain("abc");
  });
  it("no network when unconfigured", async () => {
    await writeBack({ ...base, phase: "done", origin: { kind: "jira", ref: "PROJ-1" } }, {});
    expect(calls.length).toBe(0);
  });
  it("intake Jira creds enable writeback for an origin ref", async () => {
    await writeBack({ ...base, phase: "blocked", reason: "spec conflict", origin: { kind: "jira", ref: "PROJ-123" } }, jiraEnv);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://acme.atlassian.net/rest/api/3/issue/PROJ-123/comment");
    expect(calls[0]!.body).toContain("spec conflict");
  });
  it("intake creds alone do not comment on a key found only in task text", async () => {
    await writeBack({ ...base, phase: "done", task: "fix PROJ-9 please" }, jiraEnv);
    expect(calls.length).toBe(0);
  });
  it("Jira done phase transitions when configured, other phases do not", async () => {
    await writeBack({ ...base, phase: "done", origin: { kind: "jira", ref: "PROJ-1" } }, { ...jiraEnv, LOKI_JIRA_DONE_TRANSITION: "31" });
    expect(calls.map((c) => c.url.split("/issue/")[1])).toEqual(["PROJ-1/comment", "PROJ-1/transitions"]);
    expect(JSON.parse(calls[1]!.body)).toEqual({ transition: { id: "31" } });
    calls = [];
    await writeBack({ ...base, phase: "failed", origin: { kind: "jira", ref: "PROJ-1" } }, { ...jiraEnv, LOKI_JIRA_DONE_TRANSITION: "31" });
    expect(calls.length).toBe(1);
  });
  it("Linear done phase sets state", async () => {
    await writeBack({ ...base, phase: "done", origin: { kind: "linear", ref: "ENG-42" } }, { LINEAR_API_KEY: "k", LOKI_LINEAR_DONE_STATE: "st-1" });
    expect(calls.length).toBe(2);
    expect(calls[1]!.body).toContain("issueUpdate");
    expect(JSON.parse(calls[1]!.body).variables).toEqual({ id: "ENG-42", stateId: "st-1" });
  });
  it("legacy LOKI_* config and task-text key still work", async () => {
    await writeBack({ ...base, phase: "done", task: "ship ENG-7" }, { LOKI_LINEAR_TOKEN: "k" });
    expect(calls.length).toBe(1);
  });
  it("LOKI_WRITEBACK_KIND=linear with both tracker creds makes no Jira call", async () => {
    const both = { LOKI_WRITEBACK_ISSUE: "ENG-42", LOKI_WRITEBACK_KIND: "linear", JIRA_BASE_URL: "https://j.x", JIRA_EMAIL: "a", JIRA_API_TOKEN: "t", LINEAR_API_KEY: "k" };
    await writeBack({ ...base, phase: "done" }, both);
    expect(calls.map((c) => c.url)).toEqual(["https://api.linear.app/graphql"]);
    calls = [];
    await writeBack({ ...base, phase: "done" }, { ...both, LOKI_WRITEBACK_KIND: "jira" });
    expect(calls.map((c) => c.url)).toEqual(["https://j.x/rest/api/3/issue/ENG-42/comment"]);
  });
});
