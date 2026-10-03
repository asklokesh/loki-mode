import { describe, expect, test } from "bun:test";
import { adfToText, fetchTrackerIssue, parseTrackerRef } from "../../src/features/tracker_intake.ts";

const okJson = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

describe("parseTrackerRef", () => {
  test("jira forms", () => {
    expect(parseTrackerRef("jira:PROJ-123")).toEqual({ source: "jira", key: "PROJ-123" });
    expect(parseTrackerRef("https://acme.atlassian.net/browse/PROJ-9")).toEqual({ source: "jira", key: "PROJ-9", site: "https://acme.atlassian.net" });
  });
  test("linear forms", () => {
    expect(parseTrackerRef("linear:ENG-42")).toEqual({ source: "linear", key: "ENG-42" });
    expect(parseTrackerRef("https://linear.app/acme/issue/eng-42/some-slug")).toEqual({ source: "linear", key: "ENG-42" });
  });
  test("github refs and free text are not tracker refs", () => {
    expect(parseTrackerRef("owner/repo#12")).toBeNull();
    expect(parseTrackerRef("https://github.com/o/r/issues/3")).toBeNull();
    expect(parseTrackerRef("fix the login bug")).toBeNull();
  });
});

describe("adfToText", () => {
  test("paragraphs and lists", () => {
    const doc = { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Hello" }, { type: "hardBreak" }, { type: "text", text: "world" }] },
      { type: "bulletList", content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
      ] },
      { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
    ] };
    expect(adfToText(doc)).toBe("Hello\nworld\n- a\n- b\n1. one");
  });
  test("null and string inputs", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText("plain")).toBe("plain");
  });
});

describe("fetchTrackerIssue", () => {
  test("jira normalizes and sends basic auth", async () => {
    let seen = { url: "", auth: "" };
    const f = async (url: string, init?: RequestInit) => {
      seen = { url, auth: (init?.headers as Record<string, string>).Authorization! };
      return okJson({ key: "PROJ-1", fields: { summary: "T", description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }] }, labels: ["x"], reporter: { displayName: "Ann" }, created: "2026-01-01" } })();
    };
    const env = { JIRA_BASE_URL: "https://acme.atlassian.net/", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "tok" };
    const issue = await fetchTrackerIssue({ source: "jira", key: "PROJ-1" }, f, env);
    expect(seen.url).toBe("https://acme.atlassian.net/rest/api/3/issue/PROJ-1");
    expect(seen.auth).toBe(`Basic ${Buffer.from("a@b.c:tok").toString("base64")}`);
    expect(issue).toMatchObject({ source: "jira", title: "T", body: "body", labels: ["x"], author: "Ann", url: "https://acme.atlassian.net/browse/PROJ-1" });
  });
  test("linear normalizes", async () => {
    let auth = "";
    const f = async (_u: string, init?: RequestInit) => { auth = (init?.headers as Record<string, string>).Authorization!; return okJson({ data: { issue: { identifier: "ENG-42", title: "T", description: "D", url: "https://linear.app/a/issue/ENG-42" } } })(); };
    const issue = await fetchTrackerIssue({ source: "linear", key: "ENG-42" }, f, { LINEAR_API_KEY: "k" });
    expect(auth).toBe("k");
    expect(issue).toMatchObject({ source: "linear", title: "T", body: "D", url: "https://linear.app/a/issue/ENG-42" });
  });
  test("missing env names the variable", async () => {
    await expect(fetchTrackerIssue({ source: "linear", key: "ENG-1" }, okJson({}), {})).rejects.toThrow("LINEAR_API_KEY");
    await expect(fetchTrackerIssue({ source: "jira", key: "P-1" }, okJson({}), { JIRA_BASE_URL: "https://x" })).rejects.toThrow("JIRA_EMAIL");
  });
});

describe("C7 tracker polish", () => {
  test("kill switch returns null", () => {
    expect(parseTrackerRef("jira:PROJ-1", { LOKI_TRACKER_INTAKE: "0" })).toBeNull();
    expect(parseTrackerRef("linear:ENG-1", { LOKI_TRACKER_INTAKE: "0" })).toBeNull();
  });
  test("self-hosted browse URL parses only when origin matches JIRA_BASE_URL", () => {
    const env = { JIRA_BASE_URL: "https://jira.corp.example" };
    expect(parseTrackerRef("https://jira.corp.example/browse/OPS-7", env)).toEqual({ source: "jira", key: "OPS-7", site: "https://jira.corp.example" });
    expect(parseTrackerRef("https://evil.example/browse/OPS-7", env)).toBeNull();
    expect(parseTrackerRef("https://jira.corp.example/browse/OPS-7", {})).toBeNull();
  });
  test("missing credentials name the variables", async () => {
    await expect(fetchTrackerIssue({ source: "jira", key: "P-1" }, okJson({}), { JIRA_BASE_URL: "https://x" })).rejects.toThrow("JIRA_EMAIL, JIRA_API_TOKEN and JIRA_BASE_URL");
    await expect(fetchTrackerIssue({ source: "linear", key: "E-1" }, okJson({}), {})).rejects.toThrow("Linear intake needs LINEAR_API_KEY");
  });
  test("linear 401 and errors-without-data name LINEAR_API_KEY", async () => {
    const env = { LINEAR_API_KEY: "k" };
    const r401 = async () => new Response("{}", { status: 401 });
    await expect(fetchTrackerIssue({ source: "linear", key: "E-1" }, r401, env)).rejects.toThrow("LINEAR_API_KEY");
    await expect(fetchTrackerIssue({ source: "linear", key: "E-1" }, okJson({ errors: [{ message: "Authentication required" }] }), env)).rejects.toThrow("LINEAR_API_KEY");
  });
});

describe("TRACKER-SITE-1 jira site mismatch", () => {
  const env = { JIRA_BASE_URL: "https://acme.atlassian.net", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "tok" };
  const never = async (): Promise<Response> => { throw new Error("fetch must not run"); };
  test("a browse URL on another site is refused naming both origins", async () => {
    const ref = parseTrackerRef("https://other.atlassian.net/browse/X-1", env);
    expect(ref).toEqual({ source: "jira", key: "X-1", site: "https://other.atlassian.net" });
    const err = await fetchTrackerIssue(ref as never, never, env).then(() => "", (e: Error) => e.message);
    expect(err).toContain("https://other.atlassian.net");
    expect(err).toContain("https://acme.atlassian.net");
  });
  test("suffix, userinfo and port tricks are refused", async () => {
    for (const u of ["https://acme.atlassian.net.evil.com/browse/X-1", "https://user@acme.atlassian.net/browse/X-1", "https://acme.atlassian.net:8443/browse/X-1"]) {
      expect(parseTrackerRef(u, env)).toBeNull();
      const ref = { source: "jira" as const, key: "X-1", site: u.replace(/\/browse.*$/, "") };
      await expect(fetchTrackerIssue(ref, never, env)).rejects.toThrow("does not match");
    }
  });
  test("matching origins still work", async () => {
    const f = okJson({ key: "X-1", fields: { summary: "S" } });
    const issue = await fetchTrackerIssue({ source: "jira", key: "X-1", site: "https://acme.atlassian.net" }, f, { ...env, JIRA_BASE_URL: "https://acme.atlassian.net/" });
    expect(issue.title).toBe("S");
  });
});
